import type { LinuxErrno } from './constants';

export type Qid = {
  type: number;
  version: number;
  path: bigint;
};

type Tagged = { tag: number };

export type Tversion = Tagged & { type: 'Tversion'; msize: number; version: string };
export type Tattach = Tagged & { type: 'Tattach'; fid: number; afid: number; uname: string; aname: string; nuname: number };
export type Tflush = Tagged & { type: 'Tflush'; oldtag: number };
export type Twalk = Tagged & { type: 'Twalk'; fid: number; newfid: number; wnames: string[] };
export type Tlopen = Tagged & { type: 'Tlopen'; fid: number; flags: number };
export type Tlcreate = Tagged & { type: 'Tlcreate'; fid: number; name: string; flags: number; mode: number; gid: number };
export type Tread = Tagged & { type: 'Tread'; fid: number; offset: bigint; count: number };
export type Twrite = Tagged & { type: 'Twrite'; fid: number; offset: bigint; data: Uint8Array };
export type Tclunk = Tagged & { type: 'Tclunk'; fid: number };
export type Tgetattr = Tagged & { type: 'Tgetattr'; fid: number; requestMask: bigint };
export type Tsetattr = Tagged & {
  type: 'Tsetattr'; fid: number; valid: number; mode: number; uid: number; gid: number; size: bigint;
  atimeSec: bigint; atimeNsec: bigint; mtimeSec: bigint; mtimeNsec: bigint;
};
export type Treaddir = Tagged & { type: 'Treaddir'; fid: number; offset: bigint; count: number };
export type Tfsync = Tagged & { type: 'Tfsync'; fid: number; datasync: number };
export type Tmkdir = Tagged & { type: 'Tmkdir'; fid: number; name: string; mode: number; gid: number };
export type Trenameat = Tagged & { type: 'Trenameat'; olddirfid: number; oldname: string; newdirfid: number; newname: string };
export type Tunlinkat = Tagged & { type: 'Tunlinkat'; dirfid: number; name: string; flags: number };
export type Tunknown = Tagged & { type: 'Tunknown'; messageType: number };

export type P9Request = Tversion | Tattach | Tflush | Twalk | Tlopen | Tlcreate | Tread | Twrite | Tclunk |
  Tgetattr | Tsetattr | Treaddir | Tfsync | Tmkdir | Trenameat | Tunlinkat | Tunknown;

export type Rlerror = Tagged & { type: 'Rlerror'; errno: LinuxErrno };
export type Rversion = Tagged & { type: 'Rversion'; msize: number; version: string };
export type Rattach = Tagged & { type: 'Rattach'; qid: Qid };
export type Rflush = Tagged & { type: 'Rflush' };
export type Rwalk = Tagged & { type: 'Rwalk'; qids: Qid[] };
export type Rlopen = Tagged & { type: 'Rlopen'; qid: Qid; iounit: number };
export type Rlcreate = Tagged & { type: 'Rlcreate'; qid: Qid; iounit: number };
export type Rread = Tagged & { type: 'Rread'; data: Uint8Array };
export type Rwrite = Tagged & { type: 'Rwrite'; count: number };
export type Rclunk = Tagged & { type: 'Rclunk' };
export type Rgetattr = Tagged & {
  type: 'Rgetattr'; valid: bigint; qid: Qid; mode: number; uid: number; gid: number; nlink: bigint; rdev: bigint;
  size: bigint; blksize: bigint; blocks: bigint; atimeSec: bigint; atimeNsec: bigint; mtimeSec: bigint;
  mtimeNsec: bigint; ctimeSec: bigint; ctimeNsec: bigint; btimeSec: bigint; btimeNsec: bigint; gen: bigint; dataVersion: bigint;
};
export type Rsetattr = Tagged & { type: 'Rsetattr' };
export type Rreaddir = Tagged & { type: 'Rreaddir'; data: Uint8Array };
export type Rfsync = Tagged & { type: 'Rfsync' };
export type Rmkdir = Tagged & { type: 'Rmkdir'; qid: Qid };
export type Rrenameat = Tagged & { type: 'Rrenameat' };
export type Runlinkat = Tagged & { type: 'Runlinkat' };

export type P9Response = Rlerror | Rversion | Rattach | Rflush | Rwalk | Rlopen | Rlcreate | Rread | Rwrite |
  Rclunk | Rgetattr | Rsetattr | Rreaddir | Rfsync | Rmkdir | Rrenameat | Runlinkat;
