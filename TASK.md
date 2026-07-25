# VibeStick 任务看板

> 更新于 2026-07-25。记录已完成 / 进行中 / 待办的工作。

## 已完成

### 产品基础
- [x] 固件 v2.2（M5StickC Plus）：BLE GATT 桥、IMU 横竖屏自适应、工具轮转、
      session 浏览、消息阅读、录音 RMS 全屏、transcript 确认流、虚拟麦模式、
      电源键 back/home
- [x] Host daemon：三源会话采集（adapter 文件 > 磁盘发现 > /proc 进程存在）、
      tmux / zellij / TIOCSTI-tty 三路投递、per-session FIFO 发送队列（busy 排队、
      idle 冲刷）、faster-whisper 本地 ASR、PulseAudio 虚拟麦克风
- [x] Dashboard（http://127.0.0.1:7860）：Overview / Agents(master-detail) /
      Voice & Mic / Settings 四页；桌面应用 vibestick-app + GNOME 入口 + 开机自启
- [x] 文档：README、docs/protocol.md、docs/architecture.md、host/README.md
- [x] CI：GitHub Actions（pytest + PlatformIO 双板构建）、release.yml（tag 发布固件
      + wheel）；CI 曾全绿，后因 org 私有仓库 Actions 配额/计费问题全部秒挂（非代码问题）

### 关键 bug 修复（按时间）
- [x] 语音发送后 stick 重启：栈越界 clamp + 中文触发 GLCD 渲染卡死（INT_WDT）
- [x] tty 投递只显示不输入：os.write(pts) → TIOCSTI ioctl 注入
- [x] ASR 乱码：模型 base → small、中英混合 initial_prompt、VAD 阈值、
      polyphase 重采样、clips 落盘（~/.vibestick/clips/）
- [x] thinking 常驻（多根因）：presence 覆盖 discovered idle；poll 循环被
      bridge.sync 异常静默杀死；kimi hook 缺 pid/tty 投递字段
- [x] 内核 7 TIOCSTI 仅限控制终端：运行时探针 + 推荐 tmux/zellij（均已适配，
      zellij 实测投递成功）
- [x] adapter 会话无对话内容：discovery tail 合并进 adapter 记录
- [x] BLE 频繁断连：ModemManager 探测串口复位 ESP32（udev 规则入库 +
      Troubleshooting 文档）；bridge 断连竞态 assert；daemon 单例锁（双实例互踢）
- [x] 16px 渲染：截断预扫描越界（重叠/残缺）、字库生成 bug（汉字只剩右半、
      'm' 像 'n'）→ 文泉驿微黑统一 14px 基线字库（4437 字含中文标点）
- [x] 麦克风采集质量：PDM 时钟 512kHz 出规格 → 16kHz 采集（1.024MHz）+ 2:1
      抽取 + DC 去除 + 增益 ×16
- [x] convo 界面：状态指示灯（红 busy / 蓝有待确认输入 / 绿可输入，r=4 呼吸）、
      10s 定时刷新、发送 workflow（发送即红灯 thinking，tail 推回自动刷新）、
      host 端可视化渲染模拟器（render_preview.py，四屏 PNG 目检通过）

## 进行中

- [ ] **BLE HID 键盘**（agent-2 开发到 80 步暂停，工作区改动已保留，可 resume 继续）：
      - 已完成：`firmware/src/hid.cpp/hid.h` 新建（标准 boot keyboard report map，
        扩展 usage 到 F24 容纳 F19/F20）；ble.cpp 广播加 HID service(0x1812)+
        keyboard appearance(0x03C1)；platformio.ini 相关调整；
      - 已完成：main.cpp 按键事件挂 HID 发送（按下/释放），mic 模式界面精简（ui.cpp
        +47/-11）；移除临时自动 F19 演示事件；`m5stick-c` / `m5stick-s3` 双 env
        构建通过；当前固件已刷入 M5StickC Plus（`/dev/ttyUSB0`，2026-07-25）。
      - 已验证：Ubuntu 已配对/绑定/信任并连接；同时暴露 HID (0x1812) 与
        VibeStick GATT 服务；内核已注册键盘输入 `event21`；host daemon 已实际
        连接并同步 Agent CLI 首页工具（Claude Code / Codex / opencode / Kimi CLI）。
      - 修正：HID 报告严格仅在 Microphone 模式下由 A/B 发出；Home、Sessions、
        Conversation 保留原有 Agent CLI 控制，Microphone 仍只是工具轮转中的一项。
      - 未验证：物理 A/B 的 F19/F20 键事件实测。
- [ ] **屏幕可视化调试**（排队，HID 完成后）：串口帧缓冲导出（看到真实屏幕）+
      按键事件注入遍历全部界面，横竖屏各出图，产物统一放
      /tmp/vibestick-previews/；重点修字母左右居中、中文上下裁剪；已探测实机
      ST7789 `readRect` 回读始终为全黑（该板 LCD 无可用 readback/MISO），因此
      后续截图须改为软件 framebuffer 镜像或外部相机；离线同字库预览已复现
      CJK 在右边界被硬截断。

## 待办 / 已知遗留

- [ ] 用户验证：麦克风修复后实测（10cm 说"一二三，测试麦克风"，看 RMS +
      `tail -1 ~/.vibestick/voice-log.jsonl`）；不行则发 clips 做频谱分析
- [ ] 在线 ASR 实测：Settings → Voice 填 Groq/OpenAI key → Test 按钮验证 → 激活
      （代码就绪，未做真实外网调用）
- [ ] StickS3 实机验证：按键极性、IMU 轴向、ES8311 电平（当前仅编译通过）
- [ ] 中文 GB2312 二级字库未覆盖（显示 `?`）；2bpp 抗锯齿未做（体积×2）
- [x] 主菜单 ASCII 字形修复：原文泉驿比例字体被硬裁进 8px 单元，导致 Kimi /
      Microphone 中的 `m`、`w` 等变形；ASCII 改用 DejaVu Sans Mono 13px，中文仍用
      文泉驿微黑，预览验证后已刷入当前 M5StickC Plus（2026-07-25）
- [x] opencode 实时状态同步：旧 `opencode.db` 历史会话曾错误压过正在运行的
      CLI 进程；保留 adapter 优先，同时将 live presence 会话置顶。仅凭进程存在
      不再误报 `thinking/running`，改显示为 `idle` + foreground（真正的推理状态仅由
      adapter / transcript 提供），避免 Button A 被错误变成“取消”。
- [x] 无 multiplexor 的取消兜底：对于仅有 PID/tty、但内核禁止 TIOCSTI 的 live
      CLI，设备显式 `inference.cancel` 在键盘注入失败后会发送 SIGINT；语音文本仍须
      在 tmux/zellij 运行才可可靠输入。实机 `hermes-agent` 已确认没有有效 zellij
      session，仅为 `/dev/pts/3`，这正是此前“取消看似未发送”的根因。
- [x] 普通终端会话的可迁移投递：设备 `session.new` 过去只能复用已有 tmux/zellij，
      现会在没有 anchor 时创建独立的 `vibestick-<tool>-*` tmux 会话，并以 wrapper
      启动 CLI；它会被自动发现、可监控且语音可投递。端到端实测：临时包装 pane 收到
      `VS_PROBE_OK` 后已清理。既有普通终端无法被 Linux 安全地“接管输入”，需从 Stick
      新建该替代会话或以 `vibe_wrap` 在 tmux/zellij 中启动。
- [x] live OpenCode 会话监控关联：OpenCode 的数据库保存 session `directory`；将它与
      `/proc` live CLI 的 cwd 精确匹配后，presence 会话显示真实 title、最近 tail、成本和
      基于更新时间的状态，而非空白 `hermes-agent` 占位。实机 bridge 已同步该会话的 5 条
      tail 到 M5StickC Plus（2026-07-25）。
- [x] plain tty 语音自动接力：确认语音若目标是内核禁止 TIOCSTI 的 live 普通终端，
      不再报错/丢弃；daemon 自动为同工具启动 wrapper-backed tmux，等待 adapter 记录后
      投递文本并切换 Stick 到新 session。单测覆盖启动、发现、投递、选择的完整流程；旧进程
      不会被注入或中断。
- [x] 默认四 CLI 的 id/命令映射：独立 wrapper 启动会显式传递配置工具 id，修复
      `claude-code → claude` 与 `kimi-cli → kimi` 的名称不一致；Codex、opencode 保持
      同名。四类工具均可通过同一发现、监控、tmux 新建与 plain-tty 自动语音接力路径工作。
- [x] systemd zellij 投递路径：user service 的 PATH 不含 `~/.cargo/bin`，曾使活跃
      Kimi/zellij session 报 `No such file or directory: zellij`。delivery 现优先 PATH，
      再回退到 `~/.cargo/bin/zellij`（或显式 `VIBESTICK_ZELLIJ_BIN`），已覆盖测试。
- [x] Dashboard 命令线程安全：`/api/command` 原在 HTTP worker 线程直接调用 daemon，
      `sync()` 创建 asyncio task 时会报 “no current event loop”，虽然 selection 已变更却
      返回失败。现统一 `call_soon_threadsafe` 回 daemon loop；dashboard 选择和 Stick 同步
      均可可靠完成。
- [x] 主菜单语义与会话图标：有可选 session 且未推理的工具在首页显示绿色 `ready`；纯
      `idle` 仅表示暂无 session。会话底栏改为 A/B 圆形按键、左右翻页、双击、麦克风、
      发送、停止、队列图标，替代按状态变化的长按键说明文字。已刷入当前 M5StickC Plus，
      host 回归 40 项和双板构建通过。
- [x] 会话状态灯与 footer 排版：session 列表去掉冗余 `idle` 文案，仅以红/黄/绿/灰状态灯
      标识；横屏 conversation footer 的操作图标移到右侧，避免覆盖 `thinking...` 或错误状态行。
      首页保持原有 CLI + `Microphone` 的工具轮播设计。M5StickC Plus + StickS3 编译通过，
      已刷入当前 M5StickC Plus（2026-07-25）。
- [x] session 界面预览与新会话目录：`render_preview.py` 现按固件当前状态灯、footer 图标
      与横竖屏布局生成 session PNG；目检发现并修正竖屏 `thinking...` 被 busy/record 图标压到
      下沿的问题。每个 CLI 配置新增 `cwd`（Dashboard: Working directory），全局新增
      `session_launcher`（Auto/tmux/zellij）；tmux 新窗口/独立会话使用 `-c`，zellij 新 pane
      使用 `--cwd`。空 cwd 继承已有 multiplexer pane，独立 tmux 使用用户 home；强制 zellij
      没有现存 zellij target 时明确报错。相关 host 回归通过，双板构建通过并刷入 M5StickC Plus
      （2026-07-25）。
- [x] `session.new` 陈旧 session 防御：presence/discovery 刷新可在选中 id 仍保留时移除
      record；tmux/zellij anchor 查找改为跳过失效 id，避免 BLE COMMAND callback 抛出
      `KeyError` 丢失 new-session 请求。已重启 daemon 加载当前代码。
- [x] session 阅读 footer 可视化：将控制图标下移，使 7px 圆形完全位于分界线下方；
      翻页改为 `A 圈 + 左箭头`、`B 圈 + 右箭头`，并以白底黑 `A` 表示长按 A 录音，
      去除容易误解的 `AA` 提示。横竖屏预览均已目检。
- [x] Microphone 模式 PTT/HID 语义：A 按下即发送 HID F19 down 并启动 `mode=mic`
      的 BLE raw-audio 流，松开即停止流并发送 F19 up；B 为纯 HID F20 down/up，长按 B
      不再离开该模式（侧边电源键返回）。Host 将流送入 PipeWire `VibeStick Mic`，供任意
      选择该系统输入的程序使用。
- [ ] Microphone 模式实机回归：修复 A 松开未停流（即时 PTT 改动遗漏 release 分支）并将
      显示与 PipeWire source 统一命名为 `Vibe Mic`；重刷后验证 A/F19、B/F20 真实进入 Linux
      input 设备与 PTT start/stop 成对发生。
- [x] BLE HID/GATT 自动重连：daemon 持久保存首次发现的 VibeStick 地址，后续优先
      直连该地址、失败才扫描，避免 HID 自动连接后停止广播导致 Agent 状态无法同步。
      固件进一步在任一 host 连接后继续 advertising（NimBLE 默认支持多条 peripheral
      链路）；2026-07-25 实测 HID 仍为 Connected，同时 bridge 已连接并下发
      `hermes-agent idle + foreground`。当前固件已刷入 M5StickC Plus。
- [ ] GitHub Actions 配额恢复后重跑 CI 验证 release 流水线
- [ ] 中文在 stick 上更精细的排版（间距、抗锯齿）按实机观感决定
