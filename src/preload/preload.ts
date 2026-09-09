/**
 * Preload: a única ponte entre renderer e main.
 * Expõe uma API mínima e tipada — nada de `ipcRenderer` cru no renderer.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  ExtractOptions,
  ExtractProgress,
  ExtractResult,
  VideoInfo,
} from '../shared/types';

const api = {
  /** Abre o diálogo nativo de seleção de vídeo. */
  selectVideo: (): Promise<VideoInfo | null> =>
    ipcRenderer.invoke('dialog:selectVideo'),

  /** Lê metadados de um caminho (usado no drag & drop). */
  probeVideo: (filePath: string): Promise<VideoInfo> =>
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
};

contextBridge.exposeInMainWorld('api', api);

/** Tipo exportado para o renderer declarar `window.api`. */
export type PreloadApi = typeof api;
