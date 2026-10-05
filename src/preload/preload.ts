/**
 * Preload: a única ponte entre renderer e main.
 * Expõe uma API mínima e tipada — nada de `ipcRenderer` cru no renderer.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  ApiKeyStatus,
  ExtractOptions,
  ExtractProgress,
  ExtractResult,
  TranscribeOptions,
  TranscribeProgress,
  TranscribeResult,
  MediaInfo,
} from '../shared/types';

const api = {
  /** Abre o diálogo nativo de seleção de vídeo. */
  selectVideo: (): Promise<MediaInfo | null> =>
    ipcRenderer.invoke('dialog:selectVideo'),

  /** Lê metadados de um caminho (usado no drag & drop). */
  probeVideo: (filePath: string): Promise<MediaInfo> =>
    ipcRenderer.invoke('video:probe', filePath),

  /** Diálogo de pasta de saída. */
  selectOutputDir: (): Promise<string | null> =>
    ipcRenderer.invoke('dialog:selectOutputDir'),

  /**
   * Descobre o caminho real de um File vindo do drag & drop.
   * `webUtils.getPathForFile` é a forma suportada com contextIsolation.
   */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  /** Dispara a extração e resolve com o resultado final. */
  extractAudio: (options: ExtractOptions): Promise<ExtractResult> =>
    ipcRenderer.invoke('extract:start', options),

  /** Gera e abre uma prévia de 30 s com as opções atuais. */
  previewAudio: (options: ExtractOptions): Promise<ExtractResult> =>
    ipcRenderer.invoke('preview:start', options),

  /** Cancela a extração em andamento. */
  cancelExtraction: (): Promise<boolean> => ipcRenderer.invoke('extract:cancel'),

  /** Assina o progresso; devolve uma função para cancelar a assinatura. */
  onProgress: (callback: (p: ExtractProgress) => void): (() => void) => {
    const listener = (_event: unknown, p: ExtractProgress) => callback(p);
    ipcRenderer.on('extract:progress', listener);
    return () => ipcRenderer.removeListener('extract:progress', listener);
  },

  /** Abre o explorador com o arquivo selecionado. */
  showInFolder: (filePath: string): Promise<void> =>
    ipcRenderer.invoke('shell:showInFolder', filePath),

  /** Abre o arquivo no player padrão. */
  openFile: (filePath: string): Promise<string> =>
    ipcRenderer.invoke('shell:openFile', filePath),

  /* --- Transcrição (Fase 2) --- */

  /** Escolhe um áudio já pronto para transcrever. */
  selectAudio: (): Promise<MediaInfo | null> =>
    ipcRenderer.invoke('dialog:selectAudio'),

  /** Lê metadados de um áudio (usado no drag & drop da dropzone de áudio). */
  probeAudio: (filePath: string): Promise<MediaInfo> =>
    ipcRenderer.invoke('audio:probe', filePath),

  /** Se existe chave salva, e os 4 últimos caracteres dela. */
  getApiKeyStatus: (): Promise<ApiKeyStatus> =>
    ipcRenderer.invoke('transcribe:keyStatus'),

  /** Guarda a chave cifrada pelo cofre do sistema. */
  saveApiKey: (key: string): Promise<ApiKeyStatus> =>
    ipcRenderer.invoke('transcribe:saveKey', key),

  /** Apaga a chave guardada. */
  clearApiKey: (): Promise<ApiKeyStatus> =>
    ipcRenderer.invoke('transcribe:clearKey'),

  /** Dispara a transcrição e resolve com o resultado final. */
  transcribe: (options: TranscribeOptions): Promise<TranscribeResult> =>
    ipcRenderer.invoke('transcribe:start', options),

  /** Cancela a transcrição em andamento. */
  cancelTranscription: (): Promise<boolean> =>
    ipcRenderer.invoke('transcribe:cancel'),

  /** Assina o progresso da transcrição; devolve função para desassinar. */
  onTranscribeProgress: (
    callback: (p: TranscribeProgress) => void
  ): (() => void) => {
    const listener = (_event: unknown, p: TranscribeProgress) => callback(p);
    ipcRenderer.on('transcribe:progress', listener);
    return () => ipcRenderer.removeListener('transcribe:progress', listener);
  },
};

contextBridge.exposeInMainWorld('api', api);

/** Tipo exportado para o renderer declarar `window.api`. */
export type PreloadApi = typeof api;
