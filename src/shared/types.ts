/**
 * Tipos compartilhados entre main, preload e renderer.
 * Ficam num arquivo só para os dois lados do IPC nunca saírem de sincronia.
 */

/** Formatos de saída suportados na extração. */
export type AudioFormat = 'mp3' | 'wav';

/** Opções enviadas pelo renderer ao pedir uma extração. */
export interface ExtractOptions {
  /** Caminho absoluto do vídeo de entrada. */
  inputPath: string;
  /** Formato do áudio de saída. Padrão da UI: mp3. */
  format: AudioFormat;
  /**
   * Pasta de saída. Se ficar vazio/undefined, o áudio é salvo
   * na mesma pasta do vídeo original.
   */
  outputDir?: string;
}

/** Progresso emitido durante a conversão (main -> renderer). */
export interface ExtractProgress {
  /** 0 a 100. Calculado a partir da duração total do vídeo. */
  percent: number;
  /** Segundos de vídeo já processados. */
  processedSeconds: number;
  /** Duração total em segundos (0 se não foi possível descobrir). */
  totalSeconds: number;
}

/** Resultado final da extração. */
export type ExtractResult =
  | { ok: true; outputPath: string; durationSeconds: number }
  | { ok: false; error: string };

/** Metadados básicos do vídeo selecionado, mostrados na UI. */
export interface VideoInfo {
  path: string;
  fileName: string;
  sizeBytes: number;
  durationSeconds: number;
  hasAudio: boolean;
}
