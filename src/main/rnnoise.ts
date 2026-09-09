/**
 * Localização do modelo do RNNoise usado pelo filtro `arnndn` do ffmpeg.
 *
 * O escape do caminho para dentro do filtergraph fica em audio-extractor.ts
 * (escapeFilterPath) — este módulo só descobre onde o arquivo está.
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { app } from 'electron';
import { isFilterSafePath } from './audio-extractor';

/** Nome do modelo embarcado (veja assets/rnnoise/NOTICE.md). */
const MODEL_FILE = 'bd.rnnn';

/**
 * Caminho do modelo no disco.
 * - Em desenvolvimento: `assets/rnnoise/` na raiz do projeto.
 * - No app empacotado: `resources/rnnoise/` (electron-builder `extraResources`),
 *   que fica FORA do app.asar — o ffmpeg é um processo externo e não consegue
 *   ler de dentro do asar.
 */
function findModelFile(): string {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'rnnoise', MODEL_FILE)]
    : [
        path.join(app.getAppPath(), 'assets', 'rnnoise', MODEL_FILE),
        path.join(__dirname, '../../assets/rnnoise', MODEL_FILE),
      ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Modelo de redução de ruído não encontrado (${MODEL_FILE}). ` +
      'Reinstale o app ou rode "npm install" novamente.'
  );
}

/**
 * Caminho do modelo pronto para ir dentro de um filtro do ffmpeg.
 *
 * Se o caminho de instalação contiver uma aspa simples (por exemplo um usuário
 * do Windows chamado "O'Brien"), o filtro do ffmpeg não consegue recebê-lo —
 * não existe forma de escape que sobreviva ao parser. Nesse caso copiamos o
 * modelo, uma única vez, para uma pasta sem aspas.
 */
export function resolveModelPath(): string {
  const original = findModelFile();
  if (isFilterSafePath(original)) return original;

  const fallbackBase = isFilterSafePath(os.tmpdir())
    ? os.tmpdir()
    : // Último recurso no Windows: pasta pública, que nunca tem o nome do usuário.
      process.platform === 'win32'
      ? 'C:\\Users\\Public'
      : '/tmp';

  const targetDir = path.join(fallbackBase, 'video-to-audio-modelo');
  const target = path.join(targetDir, MODEL_FILE);

  if (!isFilterSafePath(target)) {
    throw new Error(
      'Não foi possível preparar o modelo de redução de ruído: todos os ' +
        'caminhos disponíveis contêm aspas simples, que o ffmpeg não aceita.'
    );
  }

  // Copia só se ainda não existe ou se o tamanho difere (modelo atualizado).
  const source = fs.statSync(original);
  if (!fs.existsSync(target) || fs.statSync(target).size !== source.size) {
    fs.mkdirSync(targetDir, { recursive: true });
    fs.copyFileSync(original, target);
  }
  return target;
}
