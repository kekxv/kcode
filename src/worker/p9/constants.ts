export const MAX_FRAME_BYTES = 1_048_576;
export const MAX_MSIZE = MAX_FRAME_BYTES;
/** Linux 9P rejects transport sizes below this protocol minimum. */
export const P9_MIN_MSIZE = 256;
export const MAX_PATH_COMPONENT_BYTES = 255;
export const MAX_PATH_DEPTH = 64;
export const P9_HEADER_BYTES = 7;

export const MESSAGE = {
  Rlerror: 7,
  Tlopen: 12,
  Rlopen: 13,
  Tlcreate: 14,
  Rlcreate: 15,
  Tgetattr: 24,
  Rgetattr: 25,
  Tsetattr: 26,
  Rsetattr: 27,
  Treaddir: 40,
  Rreaddir: 41,
  Tfsync: 50,
  Rfsync: 51,
  Tmkdir: 72,
  Rmkdir: 73,
  Trenameat: 74,
  Rrenameat: 75,
  Tunlinkat: 76,
  Runlinkat: 77,
  Tversion: 100,
  Rversion: 101,
  Tattach: 104,
  Rattach: 105,
  Tflush: 108,
  Rflush: 109,
  Twalk: 110,
  Rwalk: 111,
  Tread: 116,
  Rread: 117,
  Twrite: 118,
  Rwrite: 119,
  Tclunk: 120,
  Rclunk: 121,
} as const;

export const ERRNO = {
  EPERM: 1,
  ENOENT: 2,
  EIO: 5,
  EBADF: 9,
  EACCES: 13,
  EBUSY: 16,
  EEXIST: 17,
  ENOTDIR: 20,
  EISDIR: 21,
  EINVAL: 22,
  ENOSPC: 28,
  ENOSYS: 38,
  ENOTEMPTY: 39,
  ETIMEDOUT: 110,
} as const;

export type LinuxErrno = (typeof ERRNO)[keyof typeof ERRNO];
