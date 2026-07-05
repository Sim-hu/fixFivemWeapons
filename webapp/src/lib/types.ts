export interface RSC7Header {
  magic: number;
  version: number;
  systemFlags: number;
  graphicsFlags: number;
  systemSize: number;
  graphicsSize: number;
}

// FiveM の stream/ にそのまま配置してストリーミングされる拡張子
export const STREAM_EXTENSIONS = new Set([
  "ybn",
  "ydd",
  "ydr",
  "yft",
  "yld",
  "ymap",
  "ynv",
  "ytyp",
  "ytd",
]);

// data/ に配置し fxmanifest.lua から参照する拡張子
export const DATA_EXTENSIONS = new Set(["dat", "meta", "rel", "ymt", "xml"]);

// FiveM リソースに混入すると害になるため除外する拡張子・ファイル名
export const EXCLUDED_EXTENSIONS = new Set(["gxt2"]);
export const EXCLUDED_FILENAMES = new Set(["content.xml", "setup2.xml"]);

// RSC7 (CodeWalker 準拠) の代表的なバージョン値。一致しない場合は警告に留める
// (Rockstar 本体でもファイル種別によって幅があるため、あくまで参考情報)
export const KNOWN_RSC_VERSIONS: Record<string, number[]> = {
  ydr: [165],
  ydd: [165],
  ybn: [43],
  ytd: [13],
};

export function getExtension(path: string): string {
  return path.split(".").pop()?.toLowerCase() ?? "";
}

export function getBaseName(path: string): string {
  return path.split("/").pop() ?? path;
}
