/**
 * Main process: janela, menu mínimo e handlers de IPC.
 * É o único lugar com acesso ao sistema de arquivos e ao ffmpeg.
 */
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import {
  probeVideo,
  startExtraction,
  VIDEO_EXTENSIONS,
  type ExtractionJob,
} from './audio-extractor';
import type {
  ExtractOptions,
  ExtractResult,
  VideoInfo,
} from '../shared/types';

let mainWindow: BrowserWindow | null = null;
/** Só permitimos uma extração por vez — simplifica a UI e o cancelamento. */
let currentJob: ExtractionJob | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 820,
    height: 680,
    minWidth: 640,
    minHeight: 560,
    title: 'Video To Audio',
    backgroundColor: '#14161a',
    webPreferences: {
      // Segurança: renderer sem Node, isolado, falando com o main só via preload.
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Cancela conversão pendente antes de sair.
  currentJob?.cancel();
  if (process.platform !== 'darwin') app.quit();
});

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

/** Abre o seletor de arquivos e retorna os metadados do vídeo escolhido. */
ipcMain.handle('dialog:selectVideo', async (): Promise<VideoInfo | null> => {
  if (!mainWindow) return null;

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Selecione o vídeo da reunião',
    properties: ['openFile'],
    filters: [
      { name: 'Vídeos', extensions: VIDEO_EXTENSIONS },
      { name: 'Todos os arquivos', extensions: ['*'] },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) return null;
  return probeVideo(result.filePaths[0]);
});

/** Usado pelo drag & drop: valida e lê metadados de um caminho já conhecido. */
ipcMain.handle(
  'video:probe',
  async (_event, filePath: string): Promise<VideoInfo> => probeVideo(filePath)
);

/** Escolha da pasta de saída (opcional; por padrão usamos a pasta do vídeo). */
ipcMain.handle('dialog:selectOutputDir', async (): Promise<string | null> => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Escolha a pasta de saída',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

/**
 * Extração propriamente dita. O progresso volta pelo canal
 * 'extract:progress'; o resultado final, como retorno do invoke.
 */
ipcMain.handle(
  'extract:start',
  async (event, options: ExtractOptions): Promise<ExtractResult> => {
    if (currentJob) {
      return { ok: false, error: 'Já existe uma extração em andamento.' };
    }

    const job = startExtraction(options, (progress) => {
      // sender pode ter sido destruído se a janela fechou no meio.
      if (!event.sender.isDestroyed()) {
        event.sender.send('extract:progress', progress);
      }
    });
    currentJob = job;

    try {
      const { outputPath, durationSeconds } = await job.promise;
      return { ok: true, outputPath, durationSeconds };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'CANCELED') {
        return { ok: false, error: 'Extração cancelada.' };
      }
      return { ok: false, error: message };
    } finally {
      currentJob = null;
    }
  }
);

/** Cancela a extração em andamento (se houver). */
ipcMain.handle('extract:cancel', (): boolean => {
  if (!currentJob) return false;
  currentJob.cancel();
  return true;
});

/** Abre o explorador de arquivos já com o áudio gerado selecionado. */
ipcMain.handle('shell:showInFolder', (_event, filePath: string): void => {
  shell.showItemInFolder(filePath);
});

/** Abre o áudio no player padrão do sistema. */
ipcMain.handle('shell:openFile', async (_event, filePath: string): Promise<string> =>
  shell.openPath(filePath)
);
