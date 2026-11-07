#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

fail() { printf '%s\n' "$*" >&2; exit 1; }

[[ "${TARGET_ARCH:-}" == amd64 ]] || fail 'Only native amd64 is allowlisted'
[[ "${TARGET_KERNEL:-}" =~ ^6\.12\.[0-9]{1,6}\+deb13-cloud-amd64$ ]] || fail 'Expected a Debian 13 6.12 cloud-amd64 kernel release'
if [[ "${1:-}" == --validate-only && $# == 1 ]]; then
    exit 0
fi
[[ $# == 0 ]] || fail 'Unsupported arguments'
[[ -f /.dockerenv ]] || fail 'Run only inside the isolated Debian container'
source /etc/os-release
[[ "$ID" == debian && "$VERSION_ID" == 13 ]] || fail 'Debian 13 required'
[[ "$(dpkg --print-architecture)" == "$TARGET_ARCH" ]] || fail 'Container architecture mismatch'
[[ -d /output && -z "$(find /output -mindepth 1 -maxdepth 1 -print -quit)" ]] || fail 'Output directory must be empty'
export DEBIAN_FRONTEND=noninteractive
work=$(mktemp -d /tmp/zfs-build.XXXXXXXX)
trap 'rm -rf -- "$work"' EXIT
printf '%s\n' \
    'deb http://deb.debian.org/debian trixie main contrib' \
    'deb http://deb.debian.org/debian trixie-updates main contrib' \
    'deb http://security.debian.org/debian-security trixie-security main contrib' > "$work/sources.list"
apt_options=(-o "Dir::Etc::sourcelist=$work/sources.list" -o Dir::Etc::sourceparts=-)
apt-get "${apt_options[@]}" update
header_package="linux-headers-$TARGET_KERNEL"
header_version=$(apt-cache "${apt_options[@]}" policy "$header_package" | awk '/Candidate:/ {print $2}')
[[ -n "$header_version" && "$header_version" != '(none)' ]] || fail "Exact matching headers unavailable: $header_package; no fallback permitted"
apt-get "${apt_options[@]}" install -y --no-install-recommends \
    build-essential autoconf automake libtool pkg-config python3 kmod file \
    libelf-dev libssl-dev zlib1g-dev "$header_package=$header_version"
[[ "$(dpkg-query -W -f='${Version}' "$header_package")" == "$header_version" ]] || fail 'Installed header package version mismatch'
headers="/usr/src/$header_package"
[[ -s "$headers/Module.symvers" && -s "$headers/include/generated/utsrelease.h" ]] || fail 'Incomplete prepared headers'
[[ "$(make -s -C "$headers" kernelrelease)" == "$TARGET_KERNEL" ]] || fail 'Header kernelrelease mismatch'
[[ "$(awk -F '"' '/^#define UTS_RELEASE / {print $2}' "$headers/include/generated/utsrelease.h")" == "$TARGET_KERNEL" ]] || fail 'Header UTS_RELEASE mismatch'
cd "$work"
apt-get "${apt_options[@]}" download "zfs-dkms:$TARGET_ARCH"
debs=("$work"/zfs-dkms_*.deb)
[[ ${#debs[@]} == 1 && -f "${debs[0]}" ]] || fail 'Expected exactly one ZFS source package'
zfs_package_version=$(dpkg-deb -f "${debs[0]}" Version)
[[ "$(dpkg-deb -f "${debs[0]}" Package)" == zfs-dkms ]] || fail 'Unexpected source package'
dpkg-deb -x "${debs[0]}" "$work/source"
sources=("$work"/source/usr/src/zfs-*)
[[ ${#sources[@]} == 1 && -d "${sources[0]}" ]] || fail 'Expected exactly one ZFS source tree'
cd "${sources[0]}"
[[ -x ./configure ]] || fail 'ZFS source package has no configure entrypoint'
./configure --with-config=kernel --with-linux="$headers" --with-linux-obj="$headers"
make -j2
stage="$work/stage"
mkdir -p "$stage/modules"
mapfile -d '' modules < <(find module -type f -name '*.ko' -print0 | sort -z)
[[ ${#modules[@]} -gt 0 ]] || fail 'Build produced no modules'
for module in "${modules[@]}"; do
    destination="$stage/modules/$(basename "$module")"
    [[ ! -e "$destination" ]] || fail 'Duplicate module basename'
    cp -- "$module" "$destination"
done
[[ -s "$stage/modules/zfs.ko" ]] || fail 'Missing zfs.ko'
export TARGET_KERNEL TARGET_ARCH SOURCE_COMMIT="${SOURCE_COMMIT:-unknown}"
export HEADER_PACKAGE="$header_package" HEADER_VERSION="$header_version" ZFS_PACKAGE_VERSION="$zfs_package_version"
export SOURCE_SHA256="$(sha256sum "${debs[0]}" | cut -d ' ' -f1)"
python3 /builder/verify-debian13-modules.py "$stage"
zfs_version=$(modinfo -F version "$stage/modules/zfs.ko")
[[ "$zfs_version" =~ ^[0-9][0-9A-Za-z.+_~-]{0,100}$ ]] || fail 'Unsafe or empty actual ZFS module version'
name="xpayincus-zfs-${zfs_version}-linux-${TARGET_ARCH}-${TARGET_KERNEL}"
mkdir "$work/publish"
mv "$stage" "$work/$name"
tar -czf "$work/publish/$name.tar.gz" -C "$work" "$name"
cp "$work/$name/metadata.json" "$work/publish/$name.metadata.json"
cd "$work/publish"
sha256sum -- *.tar.gz *.metadata.json > SHA256SUMS
sha256sum --check SHA256SUMS
cp -- ./* /output/
