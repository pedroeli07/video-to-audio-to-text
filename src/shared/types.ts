/**
 * Tipos compartilhados entre main, preload e renderer.
 * Ficam num arquivo só para os dois lados do IPC nunca saírem de sincronia.
 */

/** Formatos de saída suportados na extração. */
export type AudioFormat = 'mp3' | 'wav';

/**
 * Nível de limpeza de ruído aplicado durante a extração.
 * - 'off':   nenhum filtro, áudio igual ao do vídeo.
 * - 'leve':  corta ruído de fundo constante (ar-condicionado, ventoinha, chiado
 *            de microfone) e nivela o volume. Seguro para qualquer gravação.
 * - 'forte': mais agressivo — além do acima, limita a banda à faixa da voz e
 *            reduz sibilância. Melhor para gravações bem ruins, mas pode deixar
 *            a voz com som "abafado"/metálico.
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
   * Pasta de saída. Se ficar vazio/undefined, o áudio é salvo
   * na mesma pasta do vídeo original.
   */
  outputDir?: string;
}

/** Progresso emitido durante a conversão (main -> renderer). */
export interface ExtractProgress {
  /**
   * Etapa atual. Com limpeza de ruído ligada há uma passada rápida de
   * análise antes da conversão; a UI avisa para o usuário não achar que travou.
   */
  phase: 'analyzing' | 'converting';
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
