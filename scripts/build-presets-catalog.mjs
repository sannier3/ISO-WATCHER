/**
 * Génère presets/catalog.json depuis les configurations validées en production.
 * Usage : node scripts/build-presets-catalog.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');
const outPath = path.join(rootDir, 'presets', 'catalog.json');

const S = (key, name, url, match, o = {}) => ({
  key,
  name,
  protocol: o.p || 'https',
  url,
  allow_insecure_tls: false,
  ftp_passive: true,
  match_regex: match,
  version_regex: o.ver ?? match,
  checksum_regex: o.sum ?? null,
  discovery_enabled: Boolean(o.disc),
  discovery_depth: o.depth ?? 0,
  discovery_regex: o.discRx ?? null,
  priority: o.pri ?? 10,
  enabled: true
});

const I = (name, dist, ed, track, arch, desc) => ({
  name,
  system_family: 'linux',
  distribution: dist,
  edition: ed,
  version_track: track,
  architecture: arch,
  file_type: 'iso',
  description: desc,
  enabled: true,
  is_public: true
});

const P = (id, label, tags, iso, sources) => ({
  id,
  label,
  tags,
  stability: 'verified',
  iso_item: iso,
  sources
});

const presets = [
  P('debian-stable-netinst-amd64', 'Debian Stable Netinst AMD64', ['linux', 'debian', 'netinst', 'stable', 'amd64'],
    I('Debian Stable Netinst AMD64', 'debian', 'netinst', 'stable', 'amd64', 'ISO Debian stable netinst pour AMD64 / x86_64.'),
    [S('primary', 'Debian official current amd64 netinst', 'https://cdimage.debian.org/debian-cd/current/amd64/iso-cd/', 'debian-(?<version>[0-9.]+)-amd64-netinst\\.iso$', { sum: 'SHA256SUMS' })]),
  P('debian-stable-netinst-arm64', 'Debian Stable Netinst ARM64', ['linux', 'debian', 'netinst', 'stable', 'arm64'],
    I('Debian Stable Netinst ARM64', 'debian', 'netinst', 'stable', 'arm64', 'ISO Debian stable netinst pour ARM64 / AArch64.'),
    [S('primary', 'Debian official current arm64 netinst', 'https://cdimage.debian.org/debian-cd/current/arm64/iso-cd/', 'debian-(?<version>[0-9.]+)-arm64-netinst\\.iso$', { sum: 'SHA256SUMS' })]),
  P('debian-stable-dvd-amd64', 'Debian Stable DVD AMD64', ['linux', 'debian', 'dvd', 'stable', 'amd64'],
    I('Debian Stable DVD AMD64', 'debian', 'dvd', 'stable', 'amd64', 'ISO Debian stable DVD complet pour AMD64.'),
    [S('primary', 'Debian official current amd64 DVD', 'https://cdimage.debian.org/debian-cd/current/amd64/iso-dvd/', 'debian-(?<version>[0-9.]+)-amd64-DVD-1\\.iso$', { sum: 'SHA256SUMS' })]),
  P('debian-testing-netinst-amd64', 'Debian Testing Netinst AMD64', ['linux', 'debian', 'netinst', 'testing', 'amd64'],
    I('Debian Testing Netinst AMD64', 'debian', 'netinst', 'testing', 'amd64', 'ISO Debian testing netinst pour AMD64.'),
    [S('primary', 'Debian official testing daily amd64 netinst', 'https://cdimage.debian.org/cdimage/daily-builds/daily/current/amd64/iso-cd/', 'debian-testing-amd64-netinst\\.iso$', { ver: 'debian-(?<version>testing)-amd64-netinst\\.iso$', sum: 'SHA256SUMS', pri: 20 })]),
  P('ubuntu-desktop-lts-amd64', 'Ubuntu Desktop LTS AMD64', ['linux', 'ubuntu', 'desktop', 'lts', 'amd64'],
    I('Ubuntu Desktop LTS AMD64', 'ubuntu', 'desktop', 'lts', 'amd64', 'ISO Ubuntu Desktop LTS pour AMD64.'),
    [S('primary', 'Ubuntu releases LTS desktop amd64 auto-discovery', 'https://releases.ubuntu.com/', 'ubuntu-(?<version>[0-9.]+)-desktop-amd64\\.iso$', { sum: 'SHA256SUMS', disc: true, depth: 1, discRx: '^[0-9][02468]\\.04(?:\\.[0-9]+)?/$' })]),
  P('ubuntu-server-lts-amd64', 'Ubuntu Server LTS AMD64', ['linux', 'ubuntu', 'server', 'lts', 'amd64'],
    I('Ubuntu Server LTS AMD64', 'ubuntu', 'server', 'lts', 'amd64', 'ISO Ubuntu Server LTS pour AMD64.'),
    [S('primary', 'Ubuntu releases LTS server amd64 auto-discovery', 'https://releases.ubuntu.com/', 'ubuntu-(?<version>[0-9.]+)-live-server-amd64\\.iso$', { sum: 'SHA256SUMS', disc: true, depth: 1, discRx: '^[0-9][02468]\\.04(?:\\.[0-9]+)?/$' })]),
  P('ubuntu-server-lts-arm64', 'Ubuntu Server LTS ARM64', ['linux', 'ubuntu', 'server', 'lts', 'arm64'],
    I('Ubuntu Server LTS ARM64', 'ubuntu', 'server', 'lts', 'arm64', 'ISO Ubuntu Server LTS pour ARM64.'),
    [S('primary', 'Ubuntu cdimage LTS server arm64 auto-discovery', 'https://cdimage.ubuntu.com/releases/', 'ubuntu-(?<version>[0-9.]+)-live-server-arm64\\.iso$', { sum: 'SHA256SUMS', disc: true, depth: 2, discRx: '^(?:[0-9][02468]\\.04(?:\\.[0-9]+)?|release)/$' })]),
  P('ubuntu-desktop-latest-amd64', 'Ubuntu Desktop Latest AMD64', ['linux', 'ubuntu', 'desktop', 'latest', 'amd64'],
    I('Ubuntu Desktop Latest AMD64', 'ubuntu', 'desktop', 'latest', 'amd64', 'ISO Ubuntu Desktop dernière version standard ou LTS selon source.'),
    [S('primary', 'Ubuntu releases latest desktop amd64 auto-discovery', 'https://releases.ubuntu.com/', 'ubuntu-(?<version>[0-9.]+)-desktop-amd64\\.iso$', { sum: 'SHA256SUMS', disc: true, depth: 1, discRx: '^[0-9]{2}\\.[0-9]{2}(?:\\.[0-9]+)?/$', pri: 20 })]),
  P('ubuntu-server-latest-amd64', 'Ubuntu Server Latest AMD64', ['linux', 'ubuntu', 'server', 'latest', 'amd64'],
    I('Ubuntu Server Latest AMD64', 'ubuntu', 'server', 'latest', 'amd64', 'ISO Ubuntu Server dernière version standard ou LTS selon source.'),
    [S('primary', 'Ubuntu releases latest server amd64 auto-discovery', 'https://releases.ubuntu.com/', 'ubuntu-(?<version>[0-9.]+)-live-server-amd64\\.iso$', { sum: 'SHA256SUMS', disc: true, depth: 1, discRx: '^[0-9]{2}\\.[0-9]{2}(?:\\.[0-9]+)?/$', pri: 20 })]),
  P('linuxmint-cinnamon-amd64', 'Linux Mint Cinnamon AMD64', ['linux', 'linuxmint', 'cinnamon', 'stable', 'amd64'],
    I('Linux Mint Cinnamon AMD64', 'linuxmint', 'cinnamon', 'stable', 'amd64', 'ISO Linux Mint Cinnamon stable pour AMD64.'),
    [S('primary', 'Linux Mint stable cinnamon auto-discovery', 'https://mirrors.cicku.me/linuxmint/iso/stable/', 'linuxmint-(?<version>[0-9.]+)-cinnamon-64bit\\.iso$', { sum: 'sha256sum\\.txt', disc: true, depth: 1, discRx: '^[0-9]+\\.[0-9]+/$' })]),
  P('linuxmint-mate-amd64', 'Linux Mint MATE AMD64', ['linux', 'linuxmint', 'mate', 'stable', 'amd64'],
    I('Linux Mint MATE AMD64', 'linuxmint', 'mate', 'stable', 'amd64', 'ISO Linux Mint MATE stable pour AMD64.'),
    [S('primary', 'Linux Mint stable mate auto-discovery', 'https://mirrors.cicku.me/linuxmint/iso/stable/', 'linuxmint-(?<version>[0-9.]+)-mate-64bit\\.iso$', { sum: 'sha256sum\\.txt', disc: true, depth: 1, discRx: '^[0-9]+\\.[0-9]+/$' })]),
  P('linuxmint-xfce-amd64', 'Linux Mint Xfce AMD64', ['linux', 'linuxmint', 'xfce', 'stable', 'amd64'],
    I('Linux Mint Xfce AMD64', 'linuxmint', 'xfce', 'stable', 'amd64', 'ISO Linux Mint Xfce stable pour AMD64.'),
    [S('primary', 'Linux Mint stable xfce auto-discovery', 'https://mirrors.cicku.me/linuxmint/iso/stable/', 'linuxmint-(?<version>[0-9.]+)-xfce-64bit\\.iso$', { sum: 'sha256sum\\.txt', disc: true, depth: 1, discRx: '^[0-9]+\\.[0-9]+/$' })]),
  P('proxmox-ve-amd64', 'Proxmox VE Installer AMD64', ['linux', 'proxmox', 've', 'latest', 'amd64'],
    I('Proxmox VE Installer AMD64', 'proxmox', 've', 'latest', 'amd64', 'ISO installateur Proxmox VE.'),
    [S('primary', 'Proxmox enterprise ISO listing VE', 'https://enterprise.proxmox.com/iso/', 'proxmox-ve_(?<version>[0-9.\\-]+)\\.iso$', { sum: '\\.sha256sum$' })]),
  P('proxmox-backup-server-amd64', 'Proxmox Backup Server Installer AMD64', ['linux', 'proxmox', 'backup-server', 'latest', 'amd64'],
    I('Proxmox Backup Server Installer AMD64', 'proxmox', 'backup-server', 'latest', 'amd64', 'ISO installateur Proxmox Backup Server.'),
    [S('primary', 'Proxmox enterprise ISO listing Backup Server', 'https://enterprise.proxmox.com/iso/', 'proxmox-backup-server_(?<version>[0-9.\\-]+)\\.iso$', { sum: '\\.sha256sum$' })]),
  P('proxmox-mail-gateway-amd64', 'Proxmox Mail Gateway Installer AMD64', ['linux', 'proxmox', 'mail-gateway', 'latest', 'amd64'],
    I('Proxmox Mail Gateway Installer AMD64', 'proxmox', 'mail-gateway', 'latest', 'amd64', 'ISO installateur Proxmox Mail Gateway.'),
    [S('primary', 'Proxmox enterprise ISO listing Mail Gateway', 'https://enterprise.proxmox.com/iso/', 'proxmox-mail-gateway_(?<version>[0-9.\\-]+)\\.iso$', { sum: '\\.sha256sum$' })]),
  P('fedora-workstation-amd64', 'Fedora Workstation AMD64', ['linux', 'fedora', 'workstation', 'latest', 'amd64'],
    I('Fedora Workstation AMD64', 'fedora', 'workstation', 'latest', 'amd64', 'ISO Fedora Workstation pour AMD64.'),
    [S('primary', 'Fedora Workstation x86_64 auto-discovery', 'https://ftp.inf.utfsm.cl/fedora/linux/releases/', 'Fedora-Workstation-Live-(?<version>[0-9]+(?:-[0-9A-Za-z.]+)?)-x86_64\\.iso$', { sum: 'CHECKSUM', disc: true, depth: 4, discRx: '^(?:[0-9]+|Workstation|x86_64|iso)/$' })]),
  P('fedora-workstation-arm64', 'Fedora Workstation ARM64', ['linux', 'fedora', 'workstation', 'latest', 'arm64'],
    I('Fedora Workstation ARM64', 'fedora', 'workstation', 'latest', 'arm64', 'ISO Fedora Workstation pour ARM64.'),
    [S('primary', 'Fedora Workstation aarch64 auto-discovery', 'https://ftp.inf.utfsm.cl/fedora/linux/releases/', 'Fedora-Workstation-Live-(?<version>[0-9]+(?:-[0-9A-Za-z.]+)?)-aarch64\\.iso$', { sum: 'CHECKSUM', disc: true, depth: 4, discRx: '^(?:[0-9]+|Workstation|aarch64|iso)/$' })]),
  P('rocky-dvd-amd64', 'Rocky Linux DVD AMD64', ['linux', 'rocky', 'dvd', 'stable', 'amd64'],
    I('Rocky Linux DVD AMD64', 'rocky', 'dvd', 'stable', 'amd64', 'ISO Rocky Linux DVD pour AMD64.'),
    [S('primary', 'Rocky Linux x86_64 DVD auto-discovery', 'https://dl.rockylinux.org/pub/rocky/', 'Rocky-(?<version>[0-9.]+)-x86_64-dvd1\\.iso$', { sum: 'CHECKSUM', disc: true, depth: 3, discRx: '^(?:[0-9]+(?:\\.[0-9]+)?|isos|x86_64)/$' })]),
  P('rocky-minimal-amd64', 'Rocky Linux Minimal AMD64', ['linux', 'rocky', 'minimal', 'stable', 'amd64'],
    I('Rocky Linux Minimal AMD64', 'rocky', 'minimal', 'stable', 'amd64', 'ISO Rocky Linux Minimal pour AMD64.'),
    [S('primary', 'Rocky Linux x86_64 Minimal auto-discovery', 'https://dl.rockylinux.org/pub/rocky/', 'Rocky-(?<version>[0-9.]+)-x86_64-minimal\\.iso$', { sum: 'CHECKSUM', disc: true, depth: 3, discRx: '^(?:[0-9]+(?:\\.[0-9]+)?|isos|x86_64)/$' })]),
  P('rocky-boot-amd64', 'Rocky Linux Boot AMD64', ['linux', 'rocky', 'boot', 'stable', 'amd64'],
    I('Rocky Linux Boot AMD64', 'rocky', 'boot', 'stable', 'amd64', 'ISO Rocky Linux Boot pour installation réseau AMD64.'),
    [S('primary', 'Rocky Linux x86_64 Boot auto-discovery', 'https://dl.rockylinux.org/pub/rocky/', 'Rocky-(?<version>[0-9.]+)-x86_64-boot\\.iso$', { sum: 'CHECKSUM', disc: true, depth: 3, discRx: '^(?:[0-9]+(?:\\.[0-9]+)?|isos|x86_64)/$' })]),
  P('almalinux-dvd-amd64', 'AlmaLinux DVD AMD64', ['linux', 'almalinux', 'dvd', 'stable', 'amd64'],
    I('AlmaLinux DVD AMD64', 'almalinux', 'dvd', 'stable', 'amd64', 'ISO AlmaLinux DVD pour AMD64.'),
    [S('primary', 'AlmaLinux x86_64 DVD auto-discovery', 'https://repo.almalinux.org/almalinux/', 'AlmaLinux-(?<version>[0-9.]+)-x86_64-dvd\\.iso$', { sum: 'CHECKSUM', disc: true, depth: 3, discRx: '^(?:[0-9]+(?:\\.[0-9]+)?|isos|x86_64)/$' })]),
  P('almalinux-minimal-amd64', 'AlmaLinux Minimal AMD64', ['linux', 'almalinux', 'minimal', 'stable', 'amd64'],
    I('AlmaLinux Minimal AMD64', 'almalinux', 'minimal', 'stable', 'amd64', 'ISO AlmaLinux Minimal pour AMD64.'),
    [S('primary', 'AlmaLinux x86_64 Minimal auto-discovery', 'https://repo.almalinux.org/almalinux/', 'AlmaLinux-(?<version>[0-9.]+)-x86_64-minimal\\.iso$', { sum: 'CHECKSUM', disc: true, depth: 3, discRx: '^(?:[0-9]+(?:\\.[0-9]+)?|isos|x86_64)/$' })]),
  P('almalinux-boot-amd64', 'AlmaLinux Boot AMD64', ['linux', 'almalinux', 'boot', 'stable', 'amd64'],
    I('AlmaLinux Boot AMD64', 'almalinux', 'boot', 'stable', 'amd64', 'ISO AlmaLinux Boot pour installation réseau AMD64.'),
    [S('primary', 'AlmaLinux x86_64 Boot auto-discovery', 'https://repo.almalinux.org/almalinux/', 'AlmaLinux-(?<version>[0-9.]+)-x86_64-boot\\.iso$', { sum: 'CHECKSUM', disc: true, depth: 3, discRx: '^(?:[0-9]+(?:\\.[0-9]+)?|isos|x86_64)/$' })]),
  P('opensuse-leap-dvd-amd64', 'openSUSE Leap DVD AMD64', ['linux', 'opensuse', 'leap-dvd', 'stable', 'amd64'],
    I('openSUSE Leap DVD AMD64', 'opensuse', 'leap-dvd', 'stable', 'amd64', 'ISO openSUSE Leap DVD pour AMD64.'),
    [S('primary', 'openSUSE Leap offline x86_64 auto-discovery', 'https://download.opensuse.org/distribution/leap/', 'Leap-(?<version>[0-9.]+)-offline-installer-x86_64(?:-Build[0-9.]+)?\\.install\\.iso$', { sum: '\\.sha256$', disc: true, depth: 2, discRx: '^(?:[0-9]+\\.[0-9]+|offline)/$' })]),
  P('opensuse-tumbleweed-dvd-amd64', 'openSUSE Tumbleweed DVD AMD64', ['linux', 'opensuse', 'tumbleweed-dvd', 'rolling', 'amd64'],
    I('openSUSE Tumbleweed DVD AMD64', 'opensuse', 'tumbleweed-dvd', 'rolling', 'amd64', 'ISO openSUSE Tumbleweed rolling DVD pour AMD64.'),
    [S('primary', 'openSUSE Tumbleweed DVD x86_64 snapshot ISO', 'https://download.opensuse.org/tumbleweed/iso/', 'openSUSE-Tumbleweed-DVD-x86_64-Snapshot(?<version>[0-9]+)-Media\\.iso$', { sum: '\\.sha256$' })]),
  P('opensuse-tumbleweed-net-amd64', 'openSUSE Tumbleweed Network AMD64', ['linux', 'opensuse', 'tumbleweed-net', 'rolling', 'amd64'],
    I('openSUSE Tumbleweed Network AMD64', 'opensuse', 'tumbleweed-net', 'rolling', 'amd64', 'ISO openSUSE Tumbleweed installation réseau pour AMD64.'),
    [S('primary', 'openSUSE Tumbleweed NET x86_64 snapshot ISO', 'https://download.opensuse.org/tumbleweed/iso/', 'openSUSE-Tumbleweed-NET-x86_64-Snapshot(?<version>[0-9]+)-Media\\.iso$', { sum: '\\.sha256$' })]),
  P('archlinux-amd64', 'Arch Linux AMD64', ['linux', 'archlinux', 'releng', 'rolling', 'amd64'],
    I('Arch Linux AMD64', 'archlinux', 'releng', 'rolling', 'amd64', 'ISO Arch Linux rolling mensuelle pour AMD64.'),
    [
      S('mirror-fr', 'Arch Linux latest ISO mirror FR', 'https://mir.archlinux.fr/iso/', 'archlinux-(?<version>[0-9.]+)-x86_64\\.iso$', { sum: 'sha256sums\\.txt', disc: true, depth: 2, discRx: '^[0-9]{4}\\.[0-9]{2}\\.[0-9]{2}/$' }),
      S('archive', 'Arch Linux latest ISO geo mirror', 'https://archive.archlinux.org/iso/', 'archlinux-(?<version>[0-9.]+)-x86_64\\.iso$', { sum: 'sha256sums\\.txt', disc: true, depth: 2, discRx: '^[0-9]{4}.[0-9]{2}.[0-9]{2}/$', pri: 20 })
    ]),
  P('kali-installer-amd64', 'Kali Linux Installer AMD64', ['linux', 'kali', 'installer', 'latest', 'amd64'],
    I('Kali Linux Installer AMD64', 'kali', 'installer', 'latest', 'amd64', 'ISO installateur Kali Linux pour AMD64.'),
    [S('primary', 'Kali current installer amd64 ISO', 'https://cdimage.kali.org/current/', 'kali-linux-(?<version>[0-9.]+)-installer-amd64\\.iso$', { sum: 'SHA256SUMS' })]),
  P('endeavouros-amd64', 'EndeavourOS AMD64', ['linux', 'endeavouros', 'offline-online', 'rolling', 'amd64'],
    I('EndeavourOS AMD64', 'endeavouros', 'offline-online', 'rolling', 'amd64', 'ISO EndeavourOS pour AMD64.'),
    [S('primary', 'EndeavourOS official mirror page', 'https://endeavouros.com/', 'EndeavourOS_[A-Za-z0-9\\-]+-(?<version>[0-9.]+)\\.iso$', { sum: '\\.sha512$', pri: 30 })]),
  P('mxlinux-xfce-amd64', 'MX Linux Xfce AMD64', ['linux', 'mxlinux', 'xfce', 'stable', 'amd64'],
    I('MX Linux Xfce AMD64', 'mxlinux', 'xfce', 'stable', 'amd64', 'ISO MX Linux Xfce stable pour AMD64.'),
    [S('primary', 'MX Linux Xfce final ISO mirror', 'https://ftp.u-picardie.fr/pub/mxlinux-iso/MX/Final/Xfce/', 'MX-(?<version>[0-9.]+)_Xfce_x64\\.iso$', { sum: '\\.sha256$' })]),
  P('zorin-core-amd64', 'Zorin OS Core AMD64', ['linux', 'zorin', 'core', 'stable', 'amd64'],
    I('Zorin OS Core AMD64', 'zorin', 'core', 'stable', 'amd64', 'ISO Zorin OS Core pour AMD64.'),
    [S('primary', 'Zorin OS Core auto-discovery', 'https://mirrors.dotsrc.org/zorinos/', 'Zorin-OS-(?<version>[0-9.]+)-Core-64-bit.*\\.iso$', { sum: 'SHA256SUMS\\.txt', disc: true, depth: 1, discRx: '^[0-9]+/$', pri: 40 })]),
  P('nixos-minimal-amd64', 'NixOS Minimal AMD64', ['linux', 'nixos', 'minimal', 'stable', 'amd64'],
    I('NixOS Minimal AMD64', 'nixos', 'minimal', 'stable', 'amd64', 'ISO NixOS minimal stable pour AMD64.'),
    [S('primary', 'NixOS minimal download page', 'https://nixos.org/download/', 'latest-nixos-minimal-x86_64-linux\\.iso', { ver: 'latest-nixos-(?<version>minimal)-x86_64-linux\\.iso', sum: '\\.sha256', pri: 30 })]),
  P('gentoo-minimal-amd64', 'Gentoo Minimal AMD64', ['linux', 'gentoo', 'minimal', 'latest', 'amd64'],
    I('Gentoo Minimal AMD64', 'gentoo', 'minimal', 'latest', 'amd64', 'ISO Gentoo minimal pour AMD64.'),
    [S('primary', 'Gentoo current install minimal amd64 ISO', 'https://distfiles.gentoo.org/releases/amd64/autobuilds/current-install-amd64-minimal/', 'install-amd64-minimal-(?<version>[0-9TZ]+)\\.iso$', { sum: 'DIGESTS' })]),
  P('gentoo-livegui-amd64', 'Gentoo LiveGUI AMD64', ['linux', 'gentoo', 'livegui', 'latest', 'amd64'],
    I('Gentoo LiveGUI AMD64', 'gentoo', 'livegui', 'latest', 'amd64', 'ISO Gentoo LiveGUI pour AMD64.'),
    [S('primary', 'Gentoo current livegui amd64 ISO', 'https://distfiles.gentoo.org/releases/amd64/autobuilds/current-livegui-amd64/', 'livegui-amd64-(?<version>[0-9TZ]+)\\.iso$', { sum: 'DIGESTS' })]),
  P('clonezilla-live-amd64', 'Clonezilla Live AMD64', ['linux', 'clonezilla', 'live', 'stable', 'amd64'],
    I('Clonezilla Live AMD64', 'clonezilla', 'live', 'stable', 'amd64', 'ISO Clonezilla Live stable pour AMD64.'),
    [S('primary', 'Clonezilla stable amd64 mirror listing', 'https://free.nchc.org.tw/clonezilla-live/stable/', 'clonezilla-live-(?<version>[0-9.\\-]+)-amd64\\.iso$', { sum: 'SHA256SUMS' })]),
  P('gparted-live-amd64', 'GParted Live AMD64', ['linux', 'gparted', 'live', 'stable', 'amd64'],
    I('GParted Live AMD64', 'gparted', 'live', 'stable', 'amd64', 'ISO GParted Live stable pour AMD64.'),
    [S('primary', 'GParted official download page', 'https://gparted.org/download.php', 'gparted-live-(?<version>[0-9.\\-]+)-amd64\\.iso$', { sum: null })]),
  P('systemrescue-amd64', 'SystemRescue AMD64', ['linux', 'systemrescue', 'live', 'latest', 'amd64'],
    I('SystemRescue AMD64', 'systemrescue', 'live', 'latest', 'amd64', 'ISO SystemRescue pour AMD64.'),
    [S('primary', 'SystemRescue official download page', 'https://www.system-rescue.org/Download/', 'systemrescue-(?<version>[0-9.]+)-amd64\\.iso$', { sum: '\\.sha256$' })]),
  P('proxmox-datacenter-manager-amd64', 'Proxmox Datacenter Manager Installer AMD64', ['linux', 'proxmox', 'datacenter-manager', 'stable', 'amd64'],
    I('Proxmox Datacenter Manager Installer AMD64', 'proxmox', 'datacenter-manager', 'stable', 'amd64', 'ISO installateur Proxmox Datacenter Manager.'),
    [S('primary', 'Proxmox enterprise ISO listing Datacenter Manager', 'https://enterprise.proxmox.com/iso/', 'proxmox-datacenter-manager_(?<version>[0-9.\\-]+)\\.iso$', { sum: '\\.sha256sum$' })])
];

const catalog = {
  schema_version: 1,
  catalog_id: 'iso-watcher-default',
  updated_at: new Date().toISOString().slice(0, 10),
  presets
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
console.log(`Catalogue écrit : ${outPath} (${presets.length} presets)`);
