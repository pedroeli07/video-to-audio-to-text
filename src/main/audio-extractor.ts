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
 * Mede o piso de ruído do áudio em dBFS, com o filtro `astats`.
 *
 * Isso existe porque o denoiser (`afftdn`) precisa saber o quão alto é o
 * ruído: com um valor fixo, ou ele não limpa nada (gravação ruidosa) ou come
 * a voz junto (gravação já boa). Analisamos só os primeiros
 * ANALYSIS_SECONDS — é rápido e suficiente para caracterizar o ruído
 * constante de uma sala/microfone.
 *
 * Retorna `null` se não der para medir; nesse caso usamos um padrão seguro.
 */
const ANALYSIS_SECONDS = 120;

export async function measureNoiseFloor(
  inputPath: string,
  /** Recebe o comando para que a análise também possa ser cancelada. */
  register?: (command: FfmpegCommand) => void
): Promise<number | null> {
  setupFfmpeg();

  return new Promise((resolve) => {
    let noiseFloor: number | null = null;

    const command = ffmpeg(inputPath)
      .noVideo()
      .duration(ANALYSIS_SECONDS)
      .audioFilters('astats=metadata=1')
      .format('null')
      .on('stderr', (line: string) => {
        // A linha vem como "[Parsed_astats_0 @ ...] Noise floor dB: -48.123"
        const match = /Noise floor dB:\s*(-?\d+(?:\.\d+)?)/.exec(line);
        if (match) {
          const value = Number(match[1]);
          // Pegamos o menor valor visto (canal mais silencioso / medida global).
          if (Number.isFinite(value) && (noiseFloor === null || value < noiseFloor)) {
            noiseFloor = value;
          }
        }
      })
      .on('error', () => resolve(null))
      .on('end', () => resolve(noiseFloor));

    register?.(command);
    command.save('-');
  });
}

/**
 * Converte o piso de ruído medido no parâmetro `nf` do afftdn.
 * O filtro só aceita a faixa [-80, -20]; damos 2 dB de folga para cima para
 * o denoiser pegar o ruído inteiro sem morder o começo das palavras.
 */
export function noiseFloorToNf(noiseFloor: number | null): number {
  // -35 dBFS é um piso típico de gravação de reunião; serve de padrão seguro.
  const measured = noiseFloor ?? -35;
  return Math.max(-80, Math.min(-20, Math.round(measured + 2)));
}

/**
 * Cadeia de filtros de áudio para limpar ruído.
 *
 * A ordem importa: primeiro tiramos o que claramente não é voz (ruído grave de
 * ar-condicionado/mesa), depois o denoiser estatístico, e só no fim
 * normalizamos o volume — normalizar antes só amplificaria o ruído.
 *
 * - highpass: corta abaixo de 80/100 Hz (zumbido, trepidação, sopro de mesa).
 * - afftdn:   denoiser por FFT — é ele que realmente mata o "chiado" constante.
 *             `nf` é o piso de ruído do arquivo (medido antes, veja
 *             measureNoiseFloor) e `nr` quantos dB ele reduz.
 * - lowpass:  (só no forte) corta acima de 9 kHz, onde em gravação de reunião
 *             quase só sobra chiado — voz inteligível vive bem abaixo disso.
 * - deesser:  (só no forte) segura o "sss" estridente que o denoiser realça.
 * - dynaudnorm: nivela o volume ao longo do tempo, então quem falou longe do
 *             microfone fica audível. `g`/`f` são a janela de suavização —
 *             valores altos evitam o efeito de "bombeamento" do volume.
 *
 * Retorna [] quando o nível é 'off' (áudio sai exatamente como no vídeo).
 */
export function buildDenoiseFilters(
  level: DenoiseLevel,
  noiseFloor: number | null
): string[] {
  const nf = noiseFloorToNf(noiseFloor);

  if (level === 'leve') {
    return [
      'highpass=f=80',
      `afftdn=nr=18:nf=${nf}:nt=w`,
      'dynaudnorm=f=250:g=15:p=0.9',
    ];
  }
  if (level === 'forte') {
    return [
      'highpass=f=100',
      `afftdn=nr=28:nf=${nf}:nt=w`,
      'lowpass=f=9000',
      'deesser=i=0.4',
      'dynaudnorm=f=200:g=15:p=0.95',
    ];
  }
  return [];
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
  options: ExtractOptions,
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
    const outputPath = resolveOutputPath(
      options.inputPath,
      options.format,
      outputDir,
      denoise === 'off' ? '' : ' - limpo'
    );
    const totalSeconds = info.durationSeconds;

    // Só medimos o ruído se a limpeza estiver ligada (custa uma passada rápida).
    let noiseFloor: number | null = null;
    if (denoise !== 'off') {
      onProgress({ phase: 'analyzing', percent: 0, processedSeconds: 0, totalSeconds });
      noiseFloor = await measureNoiseFloor(options.inputPath, (cmd) => {
        command = cmd;
        // Se o cancelamento chegou antes de o comando existir, mata agora.
        if (canceled) cmd.kill('SIGKILL');
      });
      if (canceled) throw new Error('CANCELED');
    }

    await new Promise<void>((resolve, reject) => {
      // Guardamos as últimas linhas do stderr para dar um erro útil na UI.
      let stderrTail: string[] = [];

      const base = ffmpeg(options.inputPath).noVideo();

      // Filtros de limpeza (nenhum quando denoise === 'off').
      const filters = buildDenoiseFilters(denoise, noiseFloor);
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
          onProgress({ phase: 'converting', percent, processedSeconds, totalSeconds });
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
          onProgress({
            phase: 'converting',
            percent: 100,
            processedSeconds: totalSeconds,
            totalSeconds,
          });
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
