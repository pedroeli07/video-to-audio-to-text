/**
 * Toda a lógica de ffmpeg vive aqui, no main process.
 * O renderer nunca toca em arquivos nem em processos filhos.
 */
import path from 'node:path';
import fs from 'node:fs';
import ffmpeg, { FfmpegCommand } from 'fluent-ffmpeg';
import { setupFfmpeg } from './ffmpeg-setup';
import type {
  AudioFormat,
  DenoiseLevel,
  ExtractOptions,
  ExtractProgress,
  VideoInfo,
} from '../shared/types';

/** Extensões aceitas no seletor de arquivos e na validação do drag & drop. */
export const VIDEO_EXTENSIONS = [
  'mp4', 'mkv', 'mov', 'avi', 'webm', 'wmv', 'flv', 'm4v', 'mpg', 'mpeg', 'ts',
];

/**
 * Lê metadados do vídeo com ffprobe.
 * Serve para (a) validar que o arquivo é mesmo um vídeo com áudio e
 * (b) obter a duração, usada para calcular o progresso em %.
 */
export async function probeVideo(inputPath: string): Promise<VideoInfo> {
  setupFfmpeg();

  const stat = await fs.promises.stat(inputPath);
  if (!stat.isFile()) {
    throw new Error('O caminho selecionado não é um arquivo.');
  }

  const data = await new Promise<ffmpeg.FfprobeData>((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) {
        reject(
          new Error(
            'Não foi possível ler o arquivo. Ele parece não ser um vídeo válido ou está corrompido.'
          )
        );
        return;
      }
      resolve(metadata);
    });
  });

  const hasAudio = (data.streams ?? []).some((s) => s.codec_type === 'audio');
  const durationSeconds = Number(data.format?.duration ?? 0) || 0;

  return {
    path: inputPath,
    fileName: path.basename(inputPath),
    sizeBytes: stat.size,
    durationSeconds,
    hasAudio,
  };
}

/**
 * Um caminho só pode ir para dentro de um filtergraph se não tiver aspa
 * simples: o parser do ffmpeg consome a aspa em qualquer forma de escape
 * (testado — `\'`, `\\'` e `'\''` todos falham). Quem chama deve garantir
 * um caminho sem aspas (veja resolveModelPath em rnnoise.ts).
 */
export function isFilterSafePath(filePath: string): boolean {
  return !filePath.includes("'");
}

/**
 * Escapa um caminho para uso como valor de opção dentro de um filtergraph.
 *
 * O parser do ffmpeg trata `\` como escape e `:` como separador de opções,
 * então um caminho do Windows (`C:\Users\...`) quebra o filtro se for passado
 * cru — é a falha clássica que só aparece no app instalado. A ordem importa:
 * primeiro dobramos as barras invertidas, depois escapamos os dois-pontos.
 */
export function escapeFilterPath(filePath: string): string {
  return filePath.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
}

/**
 * Cadeia de filtros de limpeza de áudio.
 *
 * O trabalho pesado é do `arnndn`: o RNNoise é uma rede neural treinada para
 * separar VOZ de ruído — a cada quadro de 10 ms ela estima se há fala e o
 * quanto de cada banda de frequência é ruído, e atenua só o ruído. É por isso
 * que ele funciona onde os filtros clássicos falham: um denoiser espectral
 * (afftdn) só sabe "o que é constante", então ou deixa passar o ruído ou come
 * a voz junto. Nos testes deste projeto o afftdn sozinho chegou a piorar o
 * áudio (veja o README).
 *
 * - 'leve':  RNNoise com `mix=0.85`, ou seja, 15% do sinal original é
 *            mantido. Isso mascara os artefatos da rede e é o que teve melhor
 *            resultado médio, inclusive em gravação que já estava boa.
 * - 'forte': RNNoise em mix cheio + um `afftdn` leve para varrer o chiado
 *            residual. Ganha em gravação muito ruidosa, ao custo de mais
 *            artefato quando o áudio já era razoável.
 *
 * `normalize` (dynaudnorm) é independente do ruído: nivela o volume ao longo
 * do tempo, para quem falou longe do microfone ficar audível.
 */
export function buildDenoiseFilters(
  level: DenoiseLevel,
  modelPath: string,
  normalize = false
): string[] {
  const filters: string[] = [];
  if (level !== 'off' && !isFilterSafePath(modelPath)) {
    throw new Error(
      'O caminho do modelo de redução de ruído contém uma aspa simples, ' +
        'que o ffmpeg não aceita. Instale o app em outra pasta.'
    );
  }
  const model = escapeFilterPath(modelPath);

  if (level === 'leve') {
    filters.push(`arnndn=m=${model}:mix=0.85`);
  } else if (level === 'forte') {
    filters.push(`arnndn=m=${model}`);
    filters.push('afftdn=nr=10:nf=-40:nt=w');
  }

  // Nivelamento é opcional e vem por último: normalizar antes de limpar só
  // amplificaria o ruído.
  if (normalize) filters.push('dynaudnorm=f=250:g=15:p=0.9');

  return filters;
}

/** Codec/bitrate por formato. WAV é PCM (sem perdas, arquivo bem maior). */
function applyFormat(command: FfmpegCommand, format: AudioFormat): FfmpegCommand {
  if (format === 'wav') {
    // PCM 16 bits, 16 kHz mono: ótimo para transcrição (Fase 2) e menor que 44.1kHz estéreo.
    return command
      .audioCodec('pcm_s16le')
      .audioFrequency(16000)
      .audioChannels(1)
      .format('wav');
  }
  // MP3 padrão: bom equilíbrio entre tamanho e inteligibilidade de fala.
  return command
    .audioCodec('libmp3lame')
    .audioBitrate('128k')
    .audioChannels(1)
    .format('mp3');
}

/**
 * Gera um caminho de saída que não sobrescreve arquivos existentes:
 * "reuniao.mp3", "reuniao (1).mp3", "reuniao (2).mp3"...
 */
function resolveOutputPath(
  inputPath: string,
  format: AudioFormat,
  outputDir?: string,
  /** Sufixo opcional no nome (ex.: " - limpo"), para comparar as versões. */
  suffix = ''
): string {
  const dir = outputDir && outputDir.trim() ? outputDir : path.dirname(inputPath);
  const base = path.basename(inputPath, path.extname(inputPath)) + suffix;

  let candidate = path.join(dir, `${base}.${format}`);
  let counter = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${counter}).${format}`);
    counter += 1;
  }
  return candidate;
}

/** Converte "HH:MM:SS.xx" (formato do ffmpeg) para segundos. */
function timemarkToSeconds(timemark: string | undefined): number {
  if (!timemark) return 0;
  const parts = timemark.split(':').map((p) => Number(p));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return 0;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

/**
 * Entrada do job: as opções vindas da UI mais o caminho do modelo do RNNoise,
 * resolvido pelo main process (este módulo é propositalmente independente do
 * Electron, para poder ser testado com node puro).
 */
export interface ExtractionInput extends ExtractOptions {
  /** Caminho do .rnnn. Obrigatório quando denoise !== 'off'. */
  modelPath?: string;
  /**
   * Quando presente, converte só um trecho — usado pela prévia, para o
   * usuário conferir o resultado das opções sem processar 1 h de reunião.
   */
  preview?: { startSeconds: number; durationSeconds: number };
}

/** Handle de um job em andamento, para permitir cancelamento. */
export interface ExtractionJob {
  promise: Promise<{ outputPath: string; durationSeconds: number }>;
  cancel: () => void;
}

/**
 * Inicia a extração de áudio. Roda inteiramente no main process
 * (o ffmpeg é um processo filho), então a UI nunca trava — mesmo com
 * vídeos de várias horas / vários GB.
 */
export function startExtraction(
  options: ExtractionInput,
  onProgress: (p: ExtractProgress) => void
): ExtractionJob {
  setupFfmpeg();

  /** Comando ffmpeg em execução (análise ou conversão), para o cancelamento. */
  let command: FfmpegCommand | null = null;
  let canceled = false;

  const promise = (async () => {
    const info = await probeVideo(options.inputPath);

    if (!info.hasAudio) {
      throw new Error('Este arquivo não possui nenhuma faixa de áudio.');
    }

    const outputDir =
      options.outputDir && options.outputDir.trim()
        ? options.outputDir
        : path.dirname(options.inputPath);
    await fs.promises.mkdir(outputDir, { recursive: true });

    // Marcamos o nome quando há limpeza, para ficar fácil comparar com o original.
    const denoise = options.denoise ?? 'off';
    const modelPath = options.modelPath ?? '';
    if (denoise !== 'off' && !modelPath) {
      throw new Error('Modelo de redução de ruído não informado.');
    }
    const suffix = options.preview
      ? ' - previa'
      : denoise === 'off'
        ? ''
        : ' - limpo';
    const outputPath = resolveOutputPath(
      options.inputPath,
      options.format,
      outputDir,
      suffix
    );
    // Numa prévia, o "total" para o progresso é a duração do trecho.
    const totalSeconds = options.preview
      ? options.preview.durationSeconds
      : info.durationSeconds;

    // Só medimos o ruído se a limpeza estiver ligada (custa uma passada rápida).
    await new Promise<void>((resolve, reject) => {
      // Guardamos as últimas linhas do stderr para dar um erro útil na UI.
      let stderrTail: string[] = [];

      const base = ffmpeg(options.inputPath).noVideo();

      // Prévia: pula para o meio da gravação e converte só alguns segundos.
      // seekInput (antes do -i) é muito mais rápido em arquivos grandes.
      if (options.preview) {
        base
          .seekInput(options.preview.startSeconds)
          .duration(options.preview.durationSeconds);
      }

      // Filtros de limpeza (nenhum quando denoise === 'off').
      const filters =
        denoise === 'off'
          ? []
          : buildDenoiseFilters(denoise, modelPath, options.normalize ?? false);
      if (filters.length > 0) base.audioFilters(filters);

      command = applyFormat(base, options.format)
        .on('stderr', (line: string) => {
          stderrTail.push(line);
          if (stderrTail.length > 15) stderrTail.shift();
        })
        .on('progress', (progress) => {
          const processedSeconds = timemarkToSeconds(progress.timemark);
          const percent =
            totalSeconds > 0
              ? Math.min(100, (processedSeconds / totalSeconds) * 100)
              : // Sem duração conhecida, caímos no percent estimado do ffmpeg.
                Math.min(100, Math.max(0, progress.percent ?? 0));
          onProgress({ percent, processedSeconds, totalSeconds });
        })
        .on('error', (err) => {
          if (canceled) {
            // Remove o arquivo parcial deixado para trás pelo cancelamento.
            fs.promises.rm(outputPath, { force: true }).catch(() => undefined);
            reject(new Error('CANCELED'));
            return;
          }
          reject(
            new Error(
              `Falha ao extrair o áudio: ${err.message}\n\n${stderrTail.join('\n')}`
            )
          );
        })
        .on('end', () => {
          onProgress({ percent: 100, processedSeconds: totalSeconds, totalSeconds });
          resolve();
        });

      command.save(outputPath);
    });

    return { outputPath, durationSeconds: totalSeconds };
  })();

  return {
    promise,
    cancel: () => {
      canceled = true;
      // SIGKILL evita que o ffmpeg finalize o arquivo em conversões longas.
      try {
        command?.kill('SIGKILL');
      } catch {
        /* processo já terminou */
      }
    },
  };
}
