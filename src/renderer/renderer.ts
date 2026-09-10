/**
 * Renderer: só UI. Nenhum acesso a Node — tudo passa por `window.api`
 * (definido em src/preload/preload.ts).
 *
 * Obs.: este arquivo é um *script* (sem import/export) para poder ser
 * carregado direto com <script src>. Os tipos vêm por `import(...)`
 * no nível de tipo, que não gera código.
 */
type MediaInfo = import('../shared/types').MediaInfo;
type ExtractProgress = import('../shared/types').ExtractProgress;
type TranscribeProgress = import('../shared/types').TranscribeProgress;
type TranscriptionModel = import('../shared/types').TranscriptionModel;
type PreloadApi = import('../preload/preload').PreloadApi;

declare const api: PreloadApi;

/* ---------------------------------------------------------------- */
/* Helpers                                                           */
/* ---------------------------------------------------------------- */

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Elemento #${id} não encontrado`);
  return el as T;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return 'desconhecida';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/* ---------------------------------------------------------------- */
/* Estado                                                            */
/* ---------------------------------------------------------------- */

let selectedVideo: MediaInfo | null = null;
let customOutputDir: string | null = null;
let running = false;

const dropzone = $<HTMLElement>('dropzone');
const dropzoneFile = $<HTMLElement>('dropzone-file');
const dropzoneAudio = $<HTMLElement>('dropzone-audio');
const dropzoneAudioFile = $<HTMLElement>('dropzone-audio-file');
const fileInfo = $<HTMLElement>('file-info');
const infoName = $<HTMLElement>('info-name');
const infoSize = $<HTMLElement>('info-size');
const infoDuration = $<HTMLElement>('info-duration');
const formatSelect = $<HTMLSelectElement>('format');
const denoiseCheck = $<HTMLInputElement>('denoise');
const denoiseLevel = $<HTMLSelectElement>('denoise-level');
const denoiseHint = $<HTMLElement>('denoise-hint');
const normalizeCheck = $<HTMLInputElement>('normalize');
const btnPreview = $<HTMLButtonElement>('btn-preview');
const outputDirText = $<HTMLElement>('output-dir-text');
const btnChooseDir = $<HTMLButtonElement>('btn-choose-dir');
const btnResetDir = $<HTMLButtonElement>('btn-reset-dir');
const btnExtract = $<HTMLButtonElement>('btn-extract');
const btnCancel = $<HTMLButtonElement>('btn-cancel');
const progressBox = $<HTMLElement>('progress-box');
const progressBar = $<HTMLElement>('progress-bar');
const progressText = $<HTMLElement>('progress-text');
const statusBox = $<HTMLElement>('status-box');
const statusText = $<HTMLElement>('status-text');
const resultActions = $<HTMLElement>('result-actions');
const btnOpenFolder = $<HTMLButtonElement>('btn-open-folder');
const btnOpenFile = $<HTMLButtonElement>('btn-open-file');

/** Caminho do último áudio gerado, usado pelos botões "Abrir…". */
let lastOutputPath: string | null = null;

/* ---------------------------------------------------------------- */
/* UI                                                               */
/* ---------------------------------------------------------------- */

function showStatus(message: string, kind: 'error' | 'success' | 'info'): void {
  statusBox.classList.remove('hidden');
  statusText.textContent = message;
  statusText.className = `status ${kind === 'info' ? '' : kind}`.trim();
}

function clearStatus(): void {
  statusBox.classList.add('hidden');
  resultActions.classList.add('hidden');
  statusText.textContent = '';
}

function renderVideoInfo(): void {
  if (!selectedVideo) {
    fileInfo.classList.add('hidden');
    dropzoneFile.textContent = '';
    dropzone.classList.remove('loaded');
    btnExtract.disabled = true;
    btnPreview.disabled = true;
    return;
  }
  infoName.textContent = selectedVideo.fileName;
  infoSize.textContent = formatBytes(selectedVideo.sizeBytes);
  infoDuration.textContent = formatDuration(selectedVideo.durationSeconds);
  dropzoneFile.textContent = selectedVideo.fileName;
  dropzone.classList.add('loaded');
  fileInfo.classList.remove('hidden');
  btnExtract.disabled = running;
  btnPreview.disabled = running;
}

function setRunning(value: boolean): void {
  running = value;
  btnExtract.disabled = value || !selectedVideo;
  btnPreview.disabled = value || !selectedVideo;
  btnCancel.classList.toggle('hidden', !value);
  dropzone.style.pointerEvents = value ? 'none' : '';
  formatSelect.disabled = value;
  denoiseCheck.disabled = value;
  denoiseLevel.disabled = value;
  normalizeCheck.disabled = value;
  btnChooseDir.disabled = value;
}

/** Carrega um vídeo a partir de um caminho, tratando erros de validação. */
async function loadVideo(filePath: string): Promise<void> {
  clearStatus();
  try {
    selectedVideo = await api.probeVideo(filePath);
    if (!selectedVideo.hasAudio) {
      showStatus(
        'Atenção: este arquivo não parece ter faixa de áudio. A extração vai falhar.',
        'error'
      );
    }
  } catch (err) {
    selectedVideo = null;
    showStatus(err instanceof Error ? err.message : String(err), 'error');
  }
  renderVideoInfo();
}

/* ---------------------------------------------------------------- */
/* Eventos                                                           */
/* ---------------------------------------------------------------- */

/**
 * Liga uma dropzone: clique abre o diálogo nativo, Enter/Espaço fazem o mesmo
 * pelo teclado, e soltar um arquivo entrega o caminho. As duas zonas (vídeo e
 * áudio) precisam exatamente disso, só mudando o que fazer com o arquivo.
 */
function wireDropzone(
  zone: HTMLElement,
  handlers: {
    onClick: () => Promise<void>;
    onDrop: (filePath: string) => Promise<void>;
    onPathError: (message: string) => void;
  }
): void {
  zone.addEventListener('click', () => void handlers.onClick());

  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      zone.click();
    }
  });

  ['dragenter', 'dragover'].forEach((evt) =>
    zone.addEventListener(evt, (e) => {
      e.preventDefault();
      zone.classList.add('dragover');
    })
  );
  ['dragleave', 'drop'].forEach((evt) =>
    zone.addEventListener(evt, () => zone.classList.remove('dragover'))
  );

  zone.addEventListener('drop', async (event) => {
    event.preventDefault();
    const file = (event as DragEvent).dataTransfer?.files?.[0];
    if (!file) return;
    // Em contextIsolation, o caminho real só é obtido via webUtils (preload).
    const filePath = api.getPathForFile(file);
    if (!filePath) {
      handlers.onPathError('Não foi possível ler o caminho do arquivo arrastado.');
      return;
    }
    await handlers.onDrop(filePath);
  });
}

// Vídeo: extrai o áudio.
wireDropzone(dropzone, {
  onClick: async () => {
    clearStatus();
    try {
      const info = await api.selectVideo();
      if (info) {
        selectedVideo = info;
        if (!info.hasAudio) {
          showStatus('Atenção: este arquivo não parece ter faixa de áudio.', 'error');
        }
        renderVideoInfo();
      }
    } catch (err) {
      showStatus(err instanceof Error ? err.message : String(err), 'error');
    }
  },
  onDrop: loadVideo,
  onPathError: (message) => showStatus(message, 'error'),
});

// Áudio já pronto: pula a extração e vai direto para a transcrição.
wireDropzone(dropzoneAudio, {
  onClick: async () => {
    try {
      const info = await api.selectAudio();
      if (info) setTranscribeTarget(info);
    } catch (err) {
      showTranscribeStatus(err instanceof Error ? err.message : String(err), 'error');
    }
  },
  onDrop: loadAudio,
  onPathError: (message) => showTranscribeStatus(message, 'error'),
});

// Evita que soltar um arquivo fora da dropzone navegue a janela.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// Redução de ruído: o select de intensidade e a dica só aparecem quando ligado.
function renderDenoise(): void {
  const on = denoiseCheck.checked;
  denoiseLevel.classList.toggle('hidden', !on);
  denoiseHint.classList.toggle('hidden', !on);
  if (!on) return;
  denoiseHint.textContent =
    denoiseLevel.value === 'forte'
      ? 'Redução máxima, para gravação bem ruidosa. Deixa mais artefato se o áudio já era razoável — ouça a prévia antes.'
      : 'Uma rede neural identifica a voz quadro a quadro e atenua só o resto (chiado, ventoinha, ar-condicionado). Funciona bem com ruído constante; vozes ao fundo ela quase não remove.';
}

denoiseCheck.addEventListener('change', renderDenoise);
denoiseLevel.addEventListener('change', renderDenoise);
renderDenoise();

// Pasta de saída
btnChooseDir.addEventListener('click', async () => {
  const dir = await api.selectOutputDir();
  if (dir) {
    customOutputDir = dir;
    outputDirText.textContent = dir;
    btnResetDir.classList.remove('hidden');
  }
});

btnResetDir.addEventListener('click', () => {
  customOutputDir = null;
  outputDirText.textContent = 'Mesma pasta do vídeo';
  btnResetDir.classList.add('hidden');
});

// Progresso vindo do main
api.onProgress((p: ExtractProgress) => {
  progressBar.style.width = `${p.percent.toFixed(1)}%`;
  const done = formatDuration(p.processedSeconds);
  const total = formatDuration(p.totalSeconds);
  // Com a limpeza ligada a conversão fica mais lenta; o progresso é o mesmo.
  progressText.textContent =
    p.totalSeconds > 0
      ? `Processando… ${p.percent.toFixed(1)}% (${done} de ${total})`
      : `Processando… ${p.percent.toFixed(1)}%`;
});

/** Opções escolhidas na tela, usadas tanto pela prévia quanto pela extração. */
function currentOptions() {
  return {
    inputPath: selectedVideo!.path,
    format: formatSelect.value as 'mp3' | 'wav',
    denoise: denoiseCheck.checked
      ? (denoiseLevel.value as 'leve' | 'forte')
      : ('off' as const),
    normalize: normalizeCheck.checked,
    outputDir: customOutputDir ?? undefined,
  };
}

// Prévia: converte 30 s do meio da gravação e abre no player padrão.
btnPreview.addEventListener('click', async () => {
  if (!selectedVideo || running) return;

  clearStatus();
  setRunning(true);
  progressBox.classList.remove('hidden');
  progressBar.style.width = '0%';
  progressText.textContent = 'Gerando prévia de 30s…';

  const result = await api.previewAudio(currentOptions());

  setRunning(false);
  progressBox.classList.add('hidden');

  if (result.ok) {
    showStatus(
      `Prévia aberta no player. Se ficou bom, é só clicar em "Extrair Áudio".\n${result.outputPath}`,
      'info'
    );
  } else {
    showStatus(result.error, 'error');
  }
});

// Extração
btnExtract.addEventListener('click', async () => {
  if (!selectedVideo || running) return;

  clearStatus();
  lastOutputPath = null;
  setRunning(true);
  progressBox.classList.remove('hidden');
  progressBar.style.width = '0%';
  progressText.textContent = 'Iniciando…';

  const result = await api.extractAudio(currentOptions());

  setRunning(false);
  progressBox.classList.add('hidden');

  if (result.ok) {
    lastOutputPath = result.outputPath;
    showStatus(`Áudio salvo em:\n${result.outputPath}`, 'success');
    resultActions.classList.remove('hidden');
    // O áudio recém-gerado vira o alvo da transcrição, sem o usuário reescolher.
    setTranscribeTarget({
      path: result.outputPath,
      fileName: fileNameOf(result.outputPath),
      durationSeconds: result.durationSeconds,
    });
  } else {
    showStatus(result.error, 'error');
  }
});

btnCancel.addEventListener('click', async () => {
  await api.cancelExtraction();
});

btnOpenFolder.addEventListener('click', () => {
  if (lastOutputPath) void api.showInFolder(lastOutputPath);
});

btnOpenFile.addEventListener('click', async () => {
  if (!lastOutputPath) return;
  const error = await api.openFile(lastOutputPath);
  if (error) showStatus(`Não foi possível abrir o arquivo: ${error}`, 'error');
});

/* ---------------------------------------------------------------- */
/* Transcrição                                                       */
/* ---------------------------------------------------------------- */

const transcribeTarget = $<HTMLElement>('transcribe-target');
const apiKeyInput = $<HTMLInputElement>('api-key');
const btnSaveKey = $<HTMLButtonElement>('btn-save-key');
const btnClearKey = $<HTMLButtonElement>('btn-clear-key');
const keyStatus = $<HTMLElement>('key-status');
const btnTranscribe = $<HTMLButtonElement>('btn-transcribe');
const btnCancelTranscribe = $<HTMLButtonElement>('btn-cancel-transcribe');
const transcribeProgressBox = $<HTMLElement>('transcribe-progress-box');
const transcribeBar = $<HTMLElement>('transcribe-bar');
const transcribeProgressText = $<HTMLElement>('transcribe-progress-text');
const transcribeStatusBox = $<HTMLElement>('transcribe-status-box');
const transcribeStatusText = $<HTMLElement>('transcribe-status-text');
const transcribeActions = $<HTMLElement>('transcribe-actions');
const btnOpenTranscript = $<HTMLButtonElement>('btn-open-transcript');
const btnTranscriptFolder = $<HTMLButtonElement>('btn-transcript-folder');

/** Preço por hora de áudio, já com o adicional de diarização. */
const MODEL_RATE_USD: Record<TranscriptionModel, number> = {
  'universal-2': 0.17,
  'universal-3-5-pro': 0.23,
};

/** O que precisamos saber do áudio a transcrever. `MediaInfo` já serve. */
interface TranscribeTarget {
  path: string;
  fileName: string;
  durationSeconds: number;
}

/** Áudio que será transcrito: o último extraído, ou um solto na dropzone. */
let transcribeAudio: TranscribeTarget | null = null;
/** Caminho do último .txt gerado, para os botões "Abrir…". */
let lastTranscriptPath: string | null = null;
let transcribing = false;

function fileNameOf(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

/**
 * Mostra qual áudio será transcrito e quanto ele deve custar.
 * O custo depende do modelo marcado, então isto roda de novo a cada troca.
 */
function renderTranscribeTarget(): void {
  if (!transcribeAudio) {
    transcribeTarget.textContent = 'arraste um áudio acima, ou extraia de um vídeo';
    dropzoneAudioFile.textContent = '';
    dropzoneAudio.classList.remove('loaded');
    btnTranscribe.disabled = true;
    return;
  }

  const { fileName, durationSeconds } = transcribeAudio;
  const cost = (durationSeconds / 3600) * MODEL_RATE_USD[selectedModel()];
  transcribeTarget.textContent =
    durationSeconds > 0
      ? `${fileName} — ${formatDuration(durationSeconds)}, custo estimado US$ ${cost.toFixed(2)}`
      : fileName;

  dropzoneAudioFile.textContent = fileName;
  dropzoneAudio.classList.add('loaded');
  btnTranscribe.disabled = transcribing;
}

function setTranscribeTarget(target: TranscribeTarget | null): void {
  transcribeAudio = target;
  renderTranscribeTarget();
}

/** Carrega um áudio solto na dropzone, validando que não é vídeo. */
async function loadAudio(filePath: string): Promise<void> {
  transcribeStatusBox.classList.add('hidden');
  try {
    const info = await api.probeAudio(filePath);
    if (!info.hasAudio) {
      showTranscribeStatus('Este arquivo não tem faixa de áudio.', 'error');
      return;
    }
    setTranscribeTarget(info);
  } catch (err) {
    showTranscribeStatus(err instanceof Error ? err.message : String(err), 'error');
  }
}

function showTranscribeStatus(
  message: string,
  kind: 'error' | 'success' | 'info'
): void {
  transcribeStatusBox.classList.remove('hidden');
  transcribeStatusText.textContent = message;
  transcribeStatusText.className = `status ${kind === 'info' ? '' : kind}`.trim();
}

function setTranscribing(value: boolean): void {
  transcribing = value;
  btnTranscribe.disabled = value || !transcribeAudio;
  btnCancelTranscribe.classList.toggle('hidden', !value);
  btnSaveKey.disabled = value;
  btnClearKey.disabled = value;
  apiKeyInput.disabled = value;
  // Enquanto sobe o arquivo, trocar de áudio ou de modelo só confundiria.
  dropzoneAudio.style.pointerEvents = value ? 'none' : '';
  document
    .querySelectorAll<HTMLInputElement>('input[name="stt-model"]')
    .forEach((radio) => (radio.disabled = value));
}

function selectedModel(): TranscriptionModel {
  const checked = document.querySelector<HTMLInputElement>(
    'input[name="stt-model"]:checked'
  );
  return (checked?.value ?? 'universal-2') as TranscriptionModel;
}

/** Reflete na UI se existe chave salva (sem nunca mostrar a chave inteira). */
async function renderKeyStatus(): Promise<void> {
  const status = await api.getApiKeyStatus();
  if (status.saved) {
    keyStatus.textContent = `Chave salva (termina em ${status.hint}), cifrada pelo cofre do Windows.`;
    apiKeyInput.placeholder = 'chave salva — cole outra para trocar';
    btnClearKey.classList.remove('hidden');
  } else {
    keyStatus.textContent = 'Nenhuma chave salva. Veja o README para criar uma.';
    apiKeyInput.placeholder = 'cole aqui a chave da AssemblyAI';
    btnClearKey.classList.add('hidden');
  }
  apiKeyInput.value = '';
}

void renderKeyStatus();
setTranscribeTarget(null);

btnSaveKey.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    showTranscribeStatus('Cole a chave no campo antes de salvar.', 'error');
    return;
  }
  try {
    await api.saveApiKey(key);
    await renderKeyStatus();
    showTranscribeStatus('Chave salva.', 'success');
  } catch (err) {
    showTranscribeStatus(err instanceof Error ? err.message : String(err), 'error');
  }
});

btnClearKey.addEventListener('click', async () => {
  await api.clearApiKey();
  await renderKeyStatus();
  showTranscribeStatus('Chave removida deste computador.', 'info');
});

// Trocar de modelo muda o custo estimado mostrado ao lado do arquivo.
document
  .querySelectorAll<HTMLInputElement>('input[name="stt-model"]')
  .forEach((radio) => radio.addEventListener('change', renderTranscribeTarget));

api.onTranscribeProgress((p: TranscribeProgress) => {
  // percent === -1 significa "a API não diz o andamento": barra indeterminada.
  const unknown = p.percent < 0;
  transcribeBar.classList.toggle('indeterminate', unknown);
  transcribeBar.style.width = unknown ? '100%' : `${p.percent.toFixed(1)}%`;
  transcribeProgressText.textContent = p.message;
});

btnTranscribe.addEventListener('click', async () => {
  if (!transcribeAudio || transcribing) return;

  const model = selectedModel();
  transcribeStatusBox.classList.add('hidden');
  transcribeActions.classList.add('hidden');
  lastTranscriptPath = null;
  setTranscribing(true);
  transcribeProgressBox.classList.remove('hidden');
  transcribeBar.classList.remove('indeterminate');
  transcribeBar.style.width = '0%';
  transcribeProgressText.textContent = 'Preparando…';

  const result = await api.transcribe({ audioPath: transcribeAudio.path, model });

  setTranscribing(false);
  transcribeProgressBox.classList.add('hidden');
  transcribeBar.classList.remove('indeterminate');

  if (result.ok) {
    lastTranscriptPath = result.outputPath;
    showTranscribeStatus(
      `Transcrição pronta (${result.speakerCount} locutores identificados):\n${result.outputPath}`,
      'success'
    );
    transcribeActions.classList.remove('hidden');
  } else {
    showTranscribeStatus(result.error, 'error');
  }
});

btnCancelTranscribe.addEventListener('click', async () => {
  await api.cancelTranscription();
});

btnOpenTranscript.addEventListener('click', async () => {
  if (!lastTranscriptPath) return;
  const error = await api.openFile(lastTranscriptPath);
  if (error) showTranscribeStatus(`Não foi possível abrir: ${error}`, 'error');
});

btnTranscriptFolder.addEventListener('click', () => {
  if (lastTranscriptPath) void api.showInFolder(lastTranscriptPath);
});
