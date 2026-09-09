/**
 * Resolve os binários do ffmpeg/ffprobe empacotados com o app.
 *
 * Usamos ffmpeg-static / ffprobe-static para o usuário não precisar
 * instalar o ffmpeg manualmente. O detalhe importante é que, no app
 * empacotado pelo electron-builder, os binários ficam dentro do
 * "app.asar" (que não é executável). Por isso o package.json declara
 * esses módulos em "asarUnpack" e aqui reescrevemos o caminho para
 * apontar para "app.asar.unpacked".
 */
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
// ffprobe-static exporta um objeto { path }
import ffprobeStatic from 'ffprobe-static';

/** Converte um caminho dentro do asar no caminho realmente executável. */
function unpacked(binPath: string): string {
  return binPath.replace('app.asar', 'app.asar.unpacked');
}

let configured = false;

/** Configura o fluent-ffmpeg. Idempotente: pode ser chamado várias vezes. */
export function setupFfmpeg(): void {
  if (configured) return;

  const ffmpegPath = ffmpegStatic as unknown as string | null;
  const ffprobePath = (ffprobeStatic as unknown as { path: string }).path;

  if (!ffmpegPath) {
    throw new Error('Binário do ffmpeg não foi encontrado (ffmpeg-static).');
  }

  ffmpeg.setFfmpegPath(unpacked(ffmpegPath));
  ffmpeg.setFfprobePath(unpacked(ffprobePath));
  configured = true;
}
