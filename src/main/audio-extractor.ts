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
  MediaInfo,
} from '../shared/types';

/** Extensões aceitas no seletor de arquivos e na validação do drag & drop. */
export const VIDEO_EXTENSIONS = [
  'mp4', 'mkv', 'mov', 'avi', 'webm', 'wmv', 'flv', 'm4v', 'mpg', 'mpeg', 'ts',
];

/** Extensões oferecidas ao escolher um áudio já extraído para transcrever. */
export const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac'];

/**
 * Lê metadados de um arquivo de mídia com ffprobe.
 * Serve para (a) validar que o arquivo é mesmo mídia com faixa de áudio e
 * (b) obter a duração, usada para o progresso em % e para estimar o custo.
 *
 * `kind` só muda a mensagem de erro: o ffprobe é o mesmo para vídeo e áudio.
 */
async function probeMedia(
  inputPath: string,
  kind: 'vídeo' | 'áudio'
): Promise<MediaInfo> {
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
            `Não foi possível ler o arquivo. Ele parece não ser um ${kind} válido ou está corrompido.`
          )
        );
        return;
      }
      resolve(metadata);
    });
  });

  const streams = data.streams ?? [];
  const hasAudio = streams.some((s) => s.codec_type === 'audio');
  const durationSeconds = Number(data.format?.duration ?? 0) || 0;

  // Capa de álbum num MP3 também aparece como stream de vídeo; o que a
  // distingue de imagem em movimento é o disposition `attached_pic`.
  const hasVideoImage = streams.some(
    (s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1
  );

  return {
    path: inputPath,
    fileName: path.basename(inputPath),
    sizeBytes: stat.size,
    durationSeconds,
    hasAudio,
    hasVideoImage,
  };
}

/** Metadados do vídeo a converter. */
export const probeVideo = (inputPath: string): Promise<MediaInfo> =>
  probeMedia(inputPath, 'vídeo');

/**
 * Metadados do áudio a transcrever, quando o usuário já tem o arquivo pronto.
 *
 * Recusa vídeo de propósito: a API até aceitaria, mas subir um arquivo de
 * vários GB em vez do áudio de algumas dezenas de MB é lento à toa. O caminho
 * certo para vídeo é extrair primeiro.
 */
export async function probeAudio(inputPath: string): Promise<MediaInfo> {
  const info = await probeMedia(inputPath, 'áudio');
  if (info.hasVideoImage) {
    throw new Error(
      'Isso parece um vídeo. Solte-o no card da esquerda para extrair o áudio ' +
        'primeiro — enviar o vídeo inteiro para a API seria bem mais lento.'
    );
  }
  return info;
}

/**
 * Caracteres que nenhuma forma de escape faz sobreviver ao parser de
 * filtergraph do ffmpeg (testado com `\x` e `\\x`): a aspa simples some do
 * caminho, e `, ; [ ]` encerram o filtro no meio. Quem chama precisa fornecer
 * um caminho sem eles (veja resolveModelPath em rnnoise.ts).
 */
const FILTER_UNSAFE_CHARS = /[',;[\]]/;

/** Um caminho só pode ir para dentro de um filtergraph se passar aqui. */
export function isFilterSafePath(filePath: string): boolean {
  return !FILTER_UNSAFE_CHARS.test(filePath);
}

/**
 * Escapa um caminho para uso como valor de opção dentro de um filtergraph.
 *
 * Duas coisas, ambas verificadas rodando o ffmpeg:
 *
 * 1. As barras do Windows viram `/`. Não adianta escapá-las: `\` é sempre
 *    escape aqui, então `C:\video\assets` chega ao filtro como `C:videoassets`
 *    (o `\v` e o `\a` são consumidos) — e dobrar as barras não muda isso.
 *    O ffmpeg aceita `/` como separador de caminho no Windows.
 * 2. O `:` (separador de opções) leva DUAS barras invertidas, porque o valor
 *    passa por dois unescapes em sequência: o do filtergraph e o da opção do
 *    filtro. Com uma barra só, o caminho ainda chega quebrado.
 */
export function escapeFilterPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/:/g, '\\\\:');
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
      'O caminho do modelo de redução de ruído contém um caractere que o ' +
        "ffmpeg não aceita dentro de um filtro (' , ; [ ]). Instale o app em outra pasta."
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
 * Modo 'video': copia a faixa de vídeo sem reencodar e regrava só o áudio.
 *
 * - `-map 0:v:0 -map 0:a` mantém o vídeo e TODAS as faixas de áudio (gravação
 *   de reunião às vezes tem duas: microfone e áudio do sistema). O
 *   `-filter:a` é aplicado a cada faixa de áudio da saída — testado com duas.
 * - `-c:v copy` é o ponto central: o vídeo sai bit a bit idêntico ao original
 *   (verificado por md5 do stream), então não há perda de imagem e o
 *   processamento é rápido, limitado pelo áudio.
 * - `+faststart` move o índice do MP4 para o começo, o que ajuda players a
 *   abrir arquivos grandes sem ler tudo antes.
 */
function applyVideoPassthrough(
  command: FfmpegCommand,
  extension: string
): FfmpegCommand {
  const { codec, bitrate } = audioCodecForContainer(extension);
  const ext = extension.replace('.', '').toLowerCase();

  command
    .outputOptions(['-map', '0:v:0', '-map', '0:a', '-c:v', 'copy'])
    .audioCodec(codec)
    .audioBitrate(bitrate);

  if (['mp4', 'm4v', 'mov'].includes(ext)) {
    command.outputOptions(['-movflags', '+faststart']);
  }
  return command;
}

/**
 * Codec de áudio a usar ao regravar o vídeo, por tipo de arquivo.
 *
 * Reencodamos só o áudio (o vídeo é copiado), mas cada container aceita um
 * conjunto diferente de codecs — testado com o ffmpeg que vai no app:
 * - `.webm` só aceita Opus/Vorbis (AAC e MP3 são recusados);
 * - `.mpg`/`.mpeg` (MPEG-PS) recusa AAC: "must be one of mp1, mp2, mp3";
 * - `.avi`, `.wmv` e `.flv` aceitam AAC, mas MP3 é a opção mais compatível
 *   com players antigos, que é justamente o motivo de alguém usar esses formatos;
 * - o resto (mp4, mov, m4v, mkv, ts) vai de AAC.
 *
 * O bitrate é generoso de propósito: aqui o objetivo é assistir à reunião, não
 * economizar espaço, e a limpeza de ruído já é uma perda de informação.
 */
export function audioCodecForContainer(extension: string): {
  codec: string;
  bitrate: string;
} {
  const ext = extension.replace('.', '').toLowerCase();
  if (ext === 'webm') return { codec: 'libopus', bitrate: '128k' };
  if (['mpg', 'mpeg', 'avi', 'wmv', 'flv'].includes(ext)) {
    return { codec: 'libmp3lame', bitrate: '192k' };
  }
  return { codec: 'aac', bitrate: '192k' };
}

/**
 * Gera um caminho de saída que não sobrescreve arquivos existentes:
 * "reuniao.mp3", "reuniao (1).mp3", "reuniao (2).mp3"...
 */
function resolveOutputPath(
  inputPath: string,
  /** Extensão da saída, sem ponto (ex.: 'mp3' ou 'mp4'). */
  extension: string,
  outputDir?: string,
  /** Sufixo opcional no nome (ex.: " - limpo"), para comparar as versões. */
  suffix = ''
): string {
  const dir = outputDir && outputDir.trim() ? outputDir : path.dirname(inputPath);
  const base = path.basename(inputPath, path.extname(inputPath)) + suffix;

  let candidate = path.join(dir, `${base}.${extension}`);
  let counter = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${counter}).${extension}`);
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
    const mode = options.mode ?? 'audio';

    if (!info.hasAudio) {
      throw new Error('Este arquivo não possui nenhuma faixa de áudio.');
    }
    if (mode === 'video' && !info.hasVideoImage) {
      throw new Error(
        'Este arquivo não tem faixa de vídeo, então não há vídeo para regravar. ' +
          'Use o modo "Extrair o áudio".'
      );
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
    const normalize = options.normalize ?? false;
    if (mode === 'video' && denoise === 'off' && !normalize) {
      throw new Error(
        'No modo "vídeo com áudio limpo", ligue a redução de ruído ou o ' +
          'nivelamento de volume — sem nenhum dos dois não há o que melhorar.'
      );
    }

    // No modo vídeo a saída mantém o mesmo tipo de arquivo da entrada.
    const outputExtension =
      mode === 'video'
        ? path.extname(options.inputPath).replace('.', '').toLowerCase() || 'mp4'
        : options.format;
    const suffix = options.preview
      ? ' - previa'
      : denoise === 'off' && !normalize
        ? ''
        : ' - limpo';
    const outputPath = resolveOutputPath(
      options.inputPath,
      outputExtension,
      outputDir,
      suffix
    );
    // Numa prévia, o "total" para o progresso é a duração do trecho.
    const totalSeconds = options.preview
      ? options.preview.durationSeconds
      : info.durationSeconds;

    await new Promise<void>((resolve, reject) => {
      // Guardamos as últimas linhas do stderr para dar um erro útil na UI.
      let stderrTail: string[] = [];

      // No modo áudio descartamos o vídeo; no modo vídeo ele é copiado.
      const base = ffmpeg(options.inputPath);
      if (mode === 'audio') base.noVideo();

      // Prévia: pula para o meio da gravação e converte só alguns segundos.
      // seekInput (antes do -i) é muito mais rápido em arquivos grandes.
      if (options.preview) {
        base
          .seekInput(options.preview.startSeconds)
          .duration(options.preview.durationSeconds);
      }

      // Filtros de limpeza (nenhum quando denoise === 'off' e sem nivelamento).
      const filters = buildDenoiseFilters(denoise, modelPath, normalize);
      if (filters.length > 0) base.audioFilters(filters);

      command = (
        mode === 'video'
          ? applyVideoPassthrough(base, outputExtension)
          : applyFormat(base, options.format)
      )
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
          const acao =
            mode === 'video' ? 'Falha ao regravar o vídeo' : 'Falha ao extrair o áudio';
          reject(new Error(`${acao}: ${err.message}\n\n${stderrTail.join('\n')}`));
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
