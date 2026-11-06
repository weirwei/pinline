# Chrome 应用商店填写内容（Pinline）

上传：`npm run zip` 生成 `pinline.zip`（已去掉 manifest 的 `key`）。

## 商店信息

- 名称：Pinline
- 简短说明：Arc-style Favs, Pins and shortcuts for Chrome's native vertical tabs.
- 类别：工具（Tools）
- 图标：`icons/icon-128.png`
- 截图：至少 1 张，1280×800 或 640×400（垂直标签栏里的 Fav / Pin / 分割线，和分割线面板）

## 隐私

**单一用途**：为 Chrome 原生垂直标签栏提供 Arc 式的常驻标签（Fav / Pin）、Space 和标签管理快捷键。

**权限说明**

| 权限 | 用途 |
|---|---|
| tabs | 识别、排列、休眠和重建 Fav / Pin 标签页，切换 Space，归档标签页。 |
| storage | 在本机保存 Fav、Pin、Space、归档列表和设置。 |
| contextMenus | 在标签页右键菜单里加入「设为 Fav / Pin」「新建 Space」等命令。 |
| favicon | 休眠占位页和面板里显示网站图标。 |
| bookmarks | 把 Fav / Pin / Space 双向同步到「其他书签 / Pinline」文件夹，并支持从书签文件夹导入 Space。 |
| tabGroups | Pin 分组就是 Chrome 原生标签组：读取和恢复分组的名称、颜色、折叠状态。 |
| scripting | 用户给 Fav / Pin 改名后，只在改过名的网站上注入一个改标签标题的脚本。 |
| offscreen | 「复制当前网址」在后台写剪贴板需要一个离屏文档。 |
| clipboardWrite | 「复制当前网址」写入剪贴板。 |
| alarms | 每 15 分钟检查一次自动归档（默认关闭）。 |
| 可选 `<all_urls>` | 只有用户第一次给 Fav / Pin 改名时才询问；用于在已加载的网页上显示新名字。不授权时名字只在休眠占位页上显示。 |

`externally_connectable` 只放行 Arc Cmdbar 的 id，用于让命令栏列出和执行本插件的命令。不使用远程代码。

**数据使用**：不收集、不传输任何用户数据。数据只存在本机 `chrome.storage` 和用户自己的书签里（书签是否跨设备同步由 Chrome 自己的同步决定）。注入的改名脚本只修改页面标题，不读取页面内容。

## 上架后

商店分配 id 后，把它和 Arc Cmdbar 的 id 一起改进代码（`src/cmdbar.js`、manifest 的 `externally_connectable`、Arc Cmdbar 的 `src/pinline.js`），再把后台「软件包 → 公钥」填回 manifest 的 `key`。
