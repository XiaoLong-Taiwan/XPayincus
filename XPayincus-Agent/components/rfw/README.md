# XPayincus RFW

基於 Rust、Aya 與 eBPF/XDP 的宿主機防火牆，提供 IPv4 GeoIP、協定特徵過濾及存取統計。此目錄屬於 XPayincus Agent 宿主元件；產品發行版本讀取 [根 VERSION](../../../VERSION)，本次發行目標為 `v1.0.10`（發布狀態以 GitHub Release 為準）。RFW 在宿主機執行，不屬於面板 Compose；由獨立 Rust 程序載入 eBPF，Go Agent 不載入核心程式。整合邊界見 [元件管理](../README.md)。

## 功能與限制

- GeoIP：`--countries` 指定封鎖來源國家，`--allow-only-countries` 指定允許國家，`--block-all-from` 為指定國家全部封鎖的快捷方式。國碼以逗號分隔，啟動時需下載 GeoIP 資料。
- 協定規則：HTTP、SOCKS5、FET 嚴格／寬鬆模式、WireGuard、QUIC，以及 SMTP 相關埠與全部入站封鎖。
- 僅實作 IPv4 過濾；不能用來宣稱 IPv6 已受到相同保護。
- 特徵與統計判斷可能誤判或漏判；FET 不能保證識別特定代理軟體，也不能保證 TLS 豁免涵蓋所有合法流量。
- 吞吐量、延遲、誤報率與網卡相容性需在目標核心、驅動及流量下量測；本次未執行效能或實機驗證。

## 建置與統一發行

需要 stable Rust、nightly `rust-src`、`bpf-linker` 及相應 musl 工具鏈。正式統一產物在對應架構的 Linux 原生環境，從統一倉庫根目錄執行：

```bash
bash scripts/build-rfw-release.sh
```

產物為 `xpayincus-rfw-${VERSION}-linux-amd64` 或 `xpayincus-rfw-${VERSION}-linux-arm64`；實際輸出位置與完整流程見 [RELEASE.md](../../../RELEASE.md)。根 `.github/workflows/release.yml` 為發行入口；手動觸發只上傳 Actions artifacts，相符根版本的 tag 流程成功後發布統一 GitHub Release。子目錄 workflow 僅保留歷史參考，不作為可直接啟用的統一倉庫工作流。

在本目錄開發建置：

```bash
cargo build --locked --package rfw --release
```

各 crate 的版本由各自 `Cargo.toml` 維護；根建置腳本不會改寫。面板宿主安裝模板仍使用釘選的歷史 RFW 版本與 SHA256，不會自動切換到新的統一產物。上述命令為操作參考，本次未執行。

## 執行要求

使用支援 eBPF/XDP 的 Linux 核心與網卡，統一發行以 Linux 5.15+ 作為部署基線，但仍需實機確認核心功能及驅動支援。載入程式需要 root 或相應權限。先以 `ip link` 確認介面名稱，並保留主控台或其他管理通道，避免規則阻斷管理連線。

以下使用開發建置路徑；使用發行產物時請替換執行檔路徑：

```bash
sudo ./target/release/rfw --help
sudo ./target/release/rfw --iface eth0 --countries CN,RU --block-http --block-socks5
sudo ./target/release/rfw --iface eth0 --block-all-from CN,RU
sudo ./target/release/rfw --iface eth0 --allow-only-countries US,JP,KR --block-all
sudo ./target/release/rfw --iface eth0 --block-http
```

不設定國家時，協定規則套用至所有來源。`--countries` 與白名單／快捷模式有互斥限制，請使用單一 GeoIP 模式。

| 參數 | 用途 |
| --- | --- |
| `--block-email` | 封鎖 SMTP 相關埠 25、587、465、2525；不等於完整郵件內容檢查 |
| `--block-http` | HTTP 請求特徵過濾，不能視為完整 HTTPS 解密檢查 |
| `--block-socks5` | SOCKS5 握手特徵過濾 |
| `--block-fet-strict` / `--block-fet-loose` | 全加密流量統計特徵判斷；兩模式互斥 |
| `--block-wireguard` | WireGuard 特徵過濾 |
| `--block-quic` | QUIC v1/v2、Google QUIC 等特徵過濾 |
| `--block-all` | 全部入站封鎖，優先於協定規則 |
| `--xdp-mode auto\|skb\|drv\|hw` | 選擇附加模式，預設 auto；drv/hw 依賴驅動／硬體支援 |
| `--log-port-access` | 啟用存取統計 |

若預設 XDP 附加失敗，可在確認核心支援後嘗試 `--xdp-mode skb`。不要假設所有網卡都能使用 drv 或 hw 模式。

```bash
sudo RUST_LOG=info ./target/release/rfw --iface eth0 --countries CN --block-fet-loose --log-port-access
sudo RUST_LOG=debug ./target/release/rfw --iface eth0 --block-wireguard --block-quic
```

以前景程序執行時可按 `Ctrl+C` 停止，正常退出會卸載附加程式；異常退出後應確認實際介面狀態。

## 存取統計

防火牆必須正在執行並啟用 `--log-port-access`，且 `/sys/fs/bpf` 已掛載。統計透過 pinned eBPF maps 共享，需要存取權限：

```bash
sudo ./target/release/rfw stats
sudo ./target/release/rfw stats --port 80
sudo ./target/release/rfw stats --ip 192.0.2.10
sudo ./target/release/rfw stats --blocked-only
sudo ./target/release/rfw stats --allowed-only
sudo ./target/release/rfw stats --group-by-port
sudo ./target/release/rfw stats --port 80 --blocked-only
```

統計包含 TCP／UDP、來源 IP、目標埠及允許／封鎖次數。LRU map 最多保留 65536 條組合，舊記錄可能被淘汰，不能視為完整或持久化稽核日誌。

## 實作與資料來源

- `rfw/`：使用者空間設定、GeoIP 下載、XDP 載入及統計。
- `rfw-ebpf/`：核心封包過濾。
- `rfw-common/`：共享資料結構。
- GeoIP 使用 LPM trie 前綴比對，來源為 [sing-box-rules](https://github.com/lyc8503/sing-box-rules)；網路可用性與資料準確性需另行評估。
- 參考：[Aya](https://aya-rs.dev/)、[XDP 教學](https://github.com/xdp-project/xdp-tutorial)、[FET 論文](https://gfw.report/publications/usenixsecurity23/data/paper/paper.pdf)。

## License

With the exception of eBPF code, rfw is distributed under the terms
of either the [MIT license] or the [Apache License] (version 2.0), at your
option.

Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in this crate by you, as defined in the Apache-2.0 license, shall
be dual licensed as above, without any additional terms or conditions.

### eBPF

All eBPF code is distributed under either the terms of the
[GNU General Public License, Version 2] or the [MIT license], at your
option.

Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in this project by you, as defined in the GPL-2 license, shall be
dual licensed as above, without any additional terms or conditions.

[Apache license]: LICENSE-APACHE
[MIT license]: LICENSE-MIT
[GNU General Public License, Version 2]: LICENSE-GPL2
