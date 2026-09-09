/**
 * Tipos compartilhados entre main, preload e renderer.
 * Ficam num arquivo só para os dois lados do IPC nunca saírem de sincronia.
 */

/** Formatos de saída suportados na extração. */
export type AudioFormat = 'mp3' | 'wav';

/**
 * Nível de limpeza de ruído (RNNoise, rede neural treinada para voz).
 * - 'off':   nenhum filtro, áudio igual ao do vídeo.
 * - 'leve':  reduz ruído mantendo 15% do sinal original. Melhor resultado
 *            médio nos testes, inclusive em gravação que já estava boa.
 * - 'forte': redução cheia + varredura do chiado residual. Para gravação
 *            bem ruidosa; deixa mais artefato se o áudio já era razoável.
 */
export type DenoiseLevel = 'off' | 'leve' | 'forte';

/** Opções enviadas pelo renderer ao pedir uma extração. */
export interface ExtractOptions {
  /** Caminho absoluto do vídeo de entrada. */
  inputPath: string;
  /** Formato do áudio de saída. Padrão da UI: mp3. */
  format: AudioFormat;
  /** Limpeza de ruído. Padrão da UI: 'off'. */
  denoise: DenoiseLevel;
  /**
   * Nivela o volume ao longo da gravação (dynaudnorm), para quem falou longe
   * do microfone ficar audível. Independente da limpeza de ruído.
   */
  normalize: boolean;
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
