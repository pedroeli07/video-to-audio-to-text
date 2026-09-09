/** ffprobe-static não traz tipagem própria; só precisamos do caminho do binário. */
declare module 'ffprobe-static' {
  const ffprobe: { path: string };
  export = ffprobe;
}
