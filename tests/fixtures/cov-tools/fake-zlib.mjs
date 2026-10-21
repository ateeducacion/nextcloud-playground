// node:zlib stand-in. COV_ZLIB=missing drops zstd support (Node < 22.15);
// COV_ZLIB=identity "compresses" by returning the input, so the tar layout can
// be inspected on any Node version. Options passed are logged.
import zlib from "node:zlib";
import { record } from "./log.mjs";

const mode = process.env.COV_ZLIB;
const constants = {
  ...zlib.constants,
  ZSTD_c_compressionLevel: zlib.constants.ZSTD_c_compressionLevel ?? 100,
  ZSTD_c_enableLongDistanceMatching:
    zlib.constants.ZSTD_c_enableLongDistanceMatching ?? 160,
  ZSTD_c_windowLog: zlib.constants.ZSTD_c_windowLog ?? 101,
};

export default mode === "missing"
  ? { ...zlib, zstdCompressSync: undefined }
  : {
      ...zlib,
      constants,
      zstdCompressSync(buffer, options) {
        record({ zstd: options, constants });
        return Buffer.from(buffer);
      },
    };
