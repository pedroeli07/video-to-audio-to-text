/**
 * Transcrição via AssemblyAI, com separação de quem falou (diarização).
 *
 * ATENÇÃO: este é o único módulo do projeto que envia conteúdo para fora da
 * máquina. Todo o resto (extração, limpeza de ruído) é local. A UI avisa o
 * usuário disso antes de qualquer envio — veja o card de transcrição.
 *
 * O fluxo da API tem três passos:
 *   1. POST /v2/upload      — sobe o áudio, devolve uma URL temporária.
 *   2. POST /v2/transcript  — cria o job, devolve um id.
 *   3. GET  /v2/transcript/{id} — consulta até status virar completed/error.
 *
 * Não há webhook aqui de propósito: um app desktop não tem endereço público
 * para receber callback, então consultamos em intervalo fixo.
 */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import type {
  TranscribeOptions,
  TranscribeProgress,
  TranscriptionModel,
} from '../shared/types';

const API_HOST = 'api.assemblyai.com';
const API_BASE = `https://${API_HOST}/v2`;

/** Intervalo entre consultas de status. */
const POLL_INTERVAL_MS = 3000;

/** Nome legível de cada modelo, usado no cabeçalho do .txt e no nome do arquivo. */
export const MODEL_LABELS: Record<TranscriptionModel, string> = {
  'universal-2': 'Universal-2',
  'universal-3-5-pro': 'Universal-3.5 Pro',
};

/** Um trecho contínuo de fala de um mesmo locutor, como a API devolve. */
interface Utterance {
  speaker: string;
  text: string;
  start: number;
  end: number;
}

/** Erro de negócio da API (chave inválida, áudio sem fala, etc.). */
class ApiError extends Error {}

/* ------------------------------------------------------------------ */
/* Chamadas HTTP                                                       */
/* ------------------------------------------------------------------ */

/**
 * Sobe o arquivo de áudio.
 *
 * Aqui usamos `https.request` em vez de `fetch` porque precisamos de progresso
 * real: uma reunião de 1 h em WAV passa de 100 MB, e sem barra de progresso o
 * app pareceria travado durante todo o upload.
 */
function uploadAudio(
  filePath: string,
  apiKey: string,
  onProgress: (percent: number) => void,
  registerAbort: (abort: () => void) => void
): Promise<string> {
  const totalBytes = fs.statSync(filePath).size;

  return new Promise<string>((resolve, reject) => {
    const request = https.request(
      {
        host: API_HOST,
        path: '/v2/upload',
        method: 'POST',
        headers: {
          authorization: apiKey,
          'content-type': 'application/octet-stream',
          'content-length': totalBytes,
        },
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (body += chunk));
        response.on('end', () => {
          if (response.statusCode === 401) {
            reject(new ApiError('Chave da API recusada (401). Confira se copiou a chave inteira.'));
            return;
          }
          let parsed: { upload_url?: string; error?: string };
          try {
            parsed = JSON.parse(body);
          } catch {
            reject(new ApiError(`Resposta inesperada do upload (HTTP ${response.statusCode}).`));
            return;
          }
          if (!parsed.upload_url) {
            reject(new ApiError(parsed.error ?? `Falha no upload (HTTP ${response.statusCode}).`));
            return;
          }
          resolve(parsed.upload_url);
        });
      }
    );

    registerAbort(() => request.destroy(new Error('CANCELED')));
    request.on('error', reject);

    const stream = fs.createReadStream(filePath);
    let sent = 0;
    stream.on('data', (chunk) => {
      sent += chunk.length;
      onProgress(totalBytes > 0 ? (sent / totalBytes) * 100 : 0);
    });
    stream.on('error', reject);
    stream.pipe(request);
  });
}

/** Chamada JSON simples (criar job / consultar status). */
async function apiJson<T>(
  urlPath: string,
  apiKey: string,
  init: { method: 'GET' | 'POST'; body?: unknown; signal: AbortSignal }
): Promise<T> {
  const response = await fetch(`${API_BASE}${urlPath}`, {
    method: init.method,
    headers: {
      authorization: apiKey,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: init.signal,
  });

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(`Resposta inesperada da API (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    const message = (parsed as { error?: string }).error;
    if (response.status === 401) {
      throw new ApiError('Chave da API recusada (401). Confira se copiou a chave inteira.');
    }
    throw new ApiError(message ?? `Erro da API (HTTP ${response.status}).`);
  }
  return parsed as T;
}

/* ------------------------------------------------------------------ */
/* Formatação da saída                                                 */
/* ------------------------------------------------------------------ */

/** Milissegundos -> "HH:MM:SS", para dar para achar o trecho no áudio. */
function formatTimestamp(ms: number): string {
  const total = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

/**
 * Converte as falas da API no texto final.
 *
 * A API rotula os locutores como "A", "B", "C". Traduzimos para "Pessoa 1",
 * "Pessoa 2" pela ORDEM DE ENTRADA na conversa, não pela letra: assim
 * "Pessoa 1" é sempre quem falou primeiro, o que é mais intuitivo de ler do
 * que uma letra arbitrária.
 *
 * Os rótulos são anônimos por natureza — a diarização agrupa vozes, não sabe
 * nomes. Trocar "Pessoa 1" pelo nome real é edição manual.
 */
export function formatTranscript(
  utterances: Utterance[],
  header: { fileName: string; model: TranscriptionModel; generatedAt: Date }
): { text: string; speakerCount: number } {
  const speakerNumbers = new Map<string, number>();
  const lines = utterances.map((u) => {
    let number = speakerNumbers.get(u.speaker);
    if (number === undefined) {
      number = speakerNumbers.size + 1;
      speakerNumbers.set(u.speaker, number);
    }
    return `[${formatTimestamp(u.start)}] Pessoa ${number}: ${u.text}`;
  });

  const meta = [
    `Transcrição de: ${header.fileName}`,
    `Modelo: ${MODEL_LABELS[header.model]}`,
    `Locutores identificados: ${speakerNumbers.size}`,
    `Gerado em: ${header.generatedAt.toLocaleString('pt-BR')}`,
  ].join('\n');

  return {
    text: `${meta}\n${'-'.repeat(60)}\n\n${lines.join('\n\n')}\n`,
    speakerCount: speakerNumbers.size,
  };
}

/**
 * Caminho do .txt, com o modelo no nome — é o que permite transcrever a mesma
 * reunião nos dois modelos e ter os dois arquivos lado a lado para comparar.
 * Nunca sobrescreve: repetir o mesmo modelo gera "(1)", "(2)"…
 */
function resolveTranscriptPath(audioPath: string, model: TranscriptionModel): string {
  const dir = path.dirname(audioPath);
  const base = `${path.basename(audioPath, path.extname(audioPath))} - ${model}`;

  let candidate = path.join(dir, `${base}.txt`);
  let counter = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${counter}).txt`);
    counter += 1;
  }
  return candidate;
}

/* ------------------------------------------------------------------ */
/* Job                                                                 */
/* ------------------------------------------------------------------ */

export interface TranscriptionJob {
  promise: Promise<{ outputPath: string; speakerCount: number }>;
  cancel: () => void;
}

interface TranscriptResponse {
  id: string;
  status: 'queued' | 'processing' | 'completed' | 'error';
  error?: string;
  text?: string;
  utterances?: Utterance[];
}

/**
 * Sobe o áudio, cria o job de transcrição, acompanha até terminar e grava o
 * .txt. Espelha a forma de `startExtraction`: devolve promise + cancel, para
 * a UI tratar os dois tipos de trabalho do mesmo jeito.
 */
export function startTranscription(
  options: TranscribeOptions,
  apiKey: string,
  onProgress: (p: TranscribeProgress) => void
): TranscriptionJob {
  const controller = new AbortController();
  let canceled = false;
  let abortUpload: (() => void) | null = null;

  const promise = (async () => {
    if (!fs.existsSync(options.audioPath)) {
      throw new Error('O arquivo de áudio não existe mais. Extraia o áudio de novo.');
    }

    onProgress({ stage: 'upload', percent: 0, message: 'Enviando o áudio…' });
    const uploadUrl = await uploadAudio(
      options.audioPath,
      apiKey,
      (percent) =>
        onProgress({
          stage: 'upload',
          percent,
          message: `Enviando o áudio… ${percent.toFixed(0)}%`,
        }),
      (abort) => (abortUpload = abort)
    );
    if (canceled) throw new Error('CANCELED');

    // `speech_models` é um array de fallback, mas mandamos UM modelo só: com
    // fallback ligado a API poderia trocar de modelo sem avisar, e a
    // comparação entre os dois deixaria de significar alguma coisa.
    const created = await apiJson<TranscriptResponse>('/transcript', apiKey, {
      method: 'POST',
      signal: controller.signal,
      body: {
        audio_url: uploadUrl,
        speech_models: [options.model],
        speaker_labels: true,
        language_code: 'pt',
        ...(options.speakersExpected
          ? { speakers_expected: options.speakersExpected }
          : {}),
      },
    });

    onProgress({ stage: 'queued', percent: -1, message: 'Na fila da API…' });

    // Consulta em intervalo fixo até concluir.
    for (;;) {
      if (canceled) throw new Error('CANCELED');
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      if (canceled) throw new Error('CANCELED');

      const status = await apiJson<TranscriptResponse>(
        `/transcript/${created.id}`,
        apiKey,
        { method: 'GET', signal: controller.signal }
      );

      if (status.status === 'completed') {
        const utterances = status.utterances ?? [];
        if (utterances.length === 0) {
          throw new Error(
            'A API não encontrou fala nenhuma neste áudio. Confira se o arquivo ' +
              'tem voz audível (abra a prévia) e se não foi extraído mudo.'
          );
        }
        const { text, speakerCount } = formatTranscript(utterances, {
          fileName: path.basename(options.audioPath),
          model: options.model,
          generatedAt: new Date(),
        });
        const outputPath = resolveTranscriptPath(options.audioPath, options.model);
        await fs.promises.writeFile(outputPath, text, 'utf8');
        return { outputPath, speakerCount };
      }

      if (status.status === 'error') {
        throw new ApiError(status.error ?? 'A API não conseguiu transcrever este áudio.');
      }

      onProgress({
        stage: status.status,
        percent: -1,
        message:
          status.status === 'processing'
            ? 'Transcrevendo e separando os locutores…'
            : 'Na fila da API…',
      });
    }
  })();

  return {
    promise,
    cancel: () => {
      canceled = true;
      abortUpload?.();
      controller.abort();
    },
  };
}
