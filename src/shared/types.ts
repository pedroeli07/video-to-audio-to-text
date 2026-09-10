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

/**
 * Metadados básicos de um arquivo de mídia, mostrados na UI.
 * Serve tanto para o vídeo a extrair quanto para o áudio a transcrever —
 * os dois vêm do mesmo ffprobe.
 */
export interface MediaInfo {
  path: string;
  fileName: string;
  sizeBytes: number;
  durationSeconds: number;
  /** Falso num vídeo gravado sem microfone: não há o que extrair nem transcrever. */
  hasAudio: boolean;
  /**
   * Tem imagem em movimento, ou seja, é vídeo de verdade. Capa de álbum em
   * MP3 não conta — ela vem como stream de vídeo, mas marcada `attached_pic`.
   */
  hasVideoImage: boolean;
}

/* ------------------------------------------------------------------ */
/* Transcrição (Fase 2)                                                */
/* ------------------------------------------------------------------ */

/**
 * Modelo de transcrição da AssemblyAI. Os dois suportam português e
 * diarização; existem lado a lado para dar para transcrever a mesma reunião
 * nos dois e comparar se o mais caro compensa.
 *
 * Preço por hora de áudio, já somando o adicional de diarização (+US$ 0,02):
 * - universal-2:       US$ 0,15 + 0,02 = US$ 0,17
 * - universal-3-5-pro: US$ 0,21 + 0,02 = US$ 0,23
 */
export type TranscriptionModel = 'universal-2' | 'universal-3-5-pro';

/** Opções enviadas pelo renderer ao pedir uma transcrição. */
export interface TranscribeOptions {
  /** Caminho do áudio já extraído (mp3 ou wav). */
  audioPath: string;
  model: TranscriptionModel;
  /**
   * Quantidade de participantes, quando o usuário sabe. Opcional: sem isso a
   * API descobre sozinha, mas informar reduz erro de agrupamento de vozes.
   */
  speakersExpected?: number;
}

/** Etapa atual da transcrição, para a UI dizer o que está acontecendo. */
export type TranscribeStage = 'upload' | 'queued' | 'processing';

/** Progresso da transcrição (main -> renderer). */
export interface TranscribeProgress {
  stage: TranscribeStage;
  /**
   * 0 a 100 durante o upload. Vale -1 na fila e no processamento: a API não
   * informa andamento, então a UI mostra uma barra indeterminada.
   */
  percent: number;
  message: string;
}

/** Resultado final da transcrição. */
export type TranscribeResult =
  | {
      ok: true;
      /** Caminho do .txt gerado, com o nome do modelo no final. */
      outputPath: string;
      /** Quantas vozes distintas a diarização encontrou. */
      speakerCount: number;
      model: TranscriptionModel;
    }
  | { ok: false; error: string };

/** Estado da chave da API guardada no disco (nunca devolvemos a chave em si). */
export interface ApiKeyStatus {
  saved: boolean;
  /** Últimos 4 caracteres, só para o usuário reconhecer qual chave está lá. */
  hint?: string;
}
