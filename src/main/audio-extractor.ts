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
  outputDir?: string
): string {
  const dir = outputDir && outputDir.trim() ? outputDir : path.dirname(inputPath);
  const base = path.basename(inputPath, path.extname(inputPath));

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

    const outputPath = resolveOutputPath(
      options.inputPath,
      options.format,
      outputDir
    );
    const totalSeconds = info.durationSeconds;

    await new Promise<void>((resolve, reject) => {
      // Guardamos as últimas linhas do stderr para dar um erro útil na UI.
      let stderrTail: string[] = [];

      command = applyFormat(ffmpeg(options.inputPath).noVideo(), options.format)
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
