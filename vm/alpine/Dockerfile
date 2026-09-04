FROM docker.io/i386/alpine@sha256:fcc4c908760c4f561a5199f2e53576063b1b8eeaa0c41e6432d705aab4389753

RUN apk add --no-cache \
      openrc=0.55.1-r2 alpine-base=3.21.7-r0 agetty=2.40.4-r1 alpine-conf=3.19.2-r0 \
      linux-virt=6.12.107-r0 linux-firmware-none=20241210-r0 busybox-extras=1.37.0-r14 \
      squashfs-tools=4.6.1-r1 \
      git=2.47.3-r0 python3=3.12.14-r0 nodejs=22.23.2-r0 npm=10.9.1-r0 \
      curl=8.14.1-r2 ca-certificates=20260413-r0 \
    && mkdir -p /usr/local/share/kcode /etc/local.d \
    && apk info -vv | awk '{print $1}' | LC_ALL=C sort > /usr/local/share/kcode/apk.lock \
    && printf '%s\n' virtio_pci 9p 9pnet 9pnet_virtio >> /etc/modules \
    && sed -i '1a ::sysinit:/etc/local.d/kcode.start' /etc/inittab \
    && printf '%s\n' 'ttyS0::respawn:/sbin/agetty -L -n -l /bin/login -a root 115200 ttyS0 vt100' >> /etc/inittab \
    && rc-update add local default

COPY vm/alpine/etc/local.d/kcode.start /etc/local.d/kcode.start
RUN chmod 0755 /etc/local.d/kcode.start
