/**
 * Main process: janela, menu mínimo e handlers de IPC.
 * É o único lugar com acesso ao sistema de arquivos e ao ffmpeg.
 */
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import os from 'node:os';
import {
  AUDIO_EXTENSIONS,
  probeAudio,
  probeVideo,
  startExtraction,
  VIDEO_EXTENSIONS,
  type ExtractionJob,
} from './audio-extractor';
import { resolveModelPath } from './rnnoise';
import { startTranscription, type TranscriptionJob } from './transcriber';
import { apiKeyStatus, clearApiKey, loadApiKey, saveApiKey } from './api-key';
import type {
  ApiKeyStatus,
  ExtractOptions,
  ExtractResult,
  TranscribeOptions,
  TranscribeResult,
  MediaInfo,
} from '../shared/types';

let mainWindow: BrowserWindow | null = null;
/** Só permitimos uma extração por vez — simplifica a UI e o cancelamento. */
let currentJob: ExtractionJob | null = null;
/** Idem para a transcrição, que é independente da extração. */
let currentTranscription: TranscriptionJob | null = null;

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
  // Cancela trabalho pendente antes de sair.
  currentJob?.cancel();
  currentTranscription?.cancel();
  if (process.platform !== 'darwin') app.quit();
});

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

/** Abre o seletor de arquivos e retorna os metadados do vídeo escolhido. */
ipcMain.handle('dialog:selectVideo', async (): Promise<MediaInfo | null> => {
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
  async (_event, filePath: string): Promise<MediaInfo> => probeVideo(filePath)
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

    // O modelo do RNNoise só é necessário quando há limpeza ligada.
    let modelPath: string | undefined;
    if (options.denoise !== 'off') {
      try {
        modelPath = resolveModelPath();
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    const job = startExtraction({ ...options, modelPath }, (progress) => {
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

/**
 * Gera uma prévia curta (trecho do meio da gravação) com as opções atuais e
 * abre no player padrão. Serve para testar a limpeza sem processar o vídeo
 * inteiro — numa reunião de 1 h isso é a diferença entre 5 segundos e minutos.
 */
const PREVIEW_SECONDS = 30;

ipcMain.handle(
  'preview:start',
  async (_event, options: ExtractOptions): Promise<ExtractResult> => {
    if (currentJob) {
      return { ok: false, error: 'Aguarde a extração em andamento terminar.' };
    }

    let modelPath: string | undefined;
    if (options.denoise !== 'off') {
      try {
        modelPath = resolveModelPath();
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    try {
      const info = await probeVideo(options.inputPath);
      // Pega o meio da reunião: o começo costuma ser só gente entrando na sala.
      const start = Math.max(
        0,
        Math.floor(info.durationSeconds / 2 - PREVIEW_SECONDS / 2)
      );

      const job = startExtraction(
        {
          ...options,
          modelPath,
          // A prévia vai para a pasta temporária: é descartável.
          outputDir: path.join(os.tmpdir(), 'video-to-audio-previas'),
          preview: { startSeconds: start, durationSeconds: PREVIEW_SECONDS },
        },
        () => undefined
      );
      currentJob = job;

      const { outputPath, durationSeconds } = await job.promise;
      await shell.openPath(outputPath);
      return { ok: true, outputPath, durationSeconds };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: message === 'CANCELED' ? 'Prévia cancelada.' : message,
      };
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

/* ------------------------------------------------------------------ */
/* Transcrição (Fase 2)                                                */
/* ------------------------------------------------------------------ */

/**
 * Seleciona um áudio já extraído. Existe para dar para transcrever de novo
 * numa sessão futura sem ter que reprocessar o vídeo de 1 h só para comparar
 * os dois modelos.
 */
ipcMain.handle('dialog:selectAudio', async (): Promise<MediaInfo | null> => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Selecione o áudio para transcrever',
    properties: ['openFile'],
    filters: [
      { name: 'Áudio', extensions: AUDIO_EXTENSIONS },
      { name: 'Todos os arquivos', extensions: ['*'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return probeAudio(result.filePaths[0]);
});

/** Usado pelo drag & drop na dropzone de áudio. */
ipcMain.handle(
  'audio:probe',
  async (_event, filePath: string): Promise<MediaInfo> => probeAudio(filePath)
);

ipcMain.handle('transcribe:keyStatus', (): ApiKeyStatus => apiKeyStatus());

ipcMain.handle('transcribe:saveKey', (_event, key: string): ApiKeyStatus => {
  saveApiKey(key);
  return apiKeyStatus();
});

ipcMain.handle('transcribe:clearKey', (): ApiKeyStatus => {
  clearApiKey();
  return apiKeyStatus();
});

/**
 * Transcreve um áudio já extraído. O progresso volta por
 * 'transcribe:progress'; o resultado, como retorno do invoke.
 */
ipcMain.handle(
  'transcribe:start',
  async (event, options: TranscribeOptions): Promise<TranscribeResult> => {
    if (currentTranscription) {
      return { ok: false, error: 'Já existe uma transcrição em andamento.' };
    }

    const apiKey = loadApiKey();
    if (!apiKey) {
      return {
        ok: false,
        error:
          'Nenhuma chave da API salva. Cole sua chave da AssemblyAI no campo ' +
          'acima e clique em salvar. O README explica como obter uma.',
      };
    }

    const job = startTranscription(options, apiKey, (progress) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('transcribe:progress', progress);
      }
    });
    currentTranscription = job;

    try {
      const { outputPath, speakerCount } = await job.promise;
      return { ok: true, outputPath, speakerCount, model: options.model };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'CANCELED') {
        return { ok: false, error: 'Transcrição cancelada.' };
      }
      return { ok: false, error: message };
    } finally {
      currentTranscription = null;
    }
  }
);

/** Cancela a transcrição em andamento (se houver). */
ipcMain.handle('transcribe:cancel', (): boolean => {
  if (!currentTranscription) return false;
  currentTranscription.cancel();
  return true;
});
