<h1 align="center">Arca-Launcher</h1>

<p align="center">
  A custom Minecraft launcher built with Tauri, Vite, Rust, and TypeScript.
</p>

Arca-Launcher is an indie project focused on creating a personalized and user-friendly Minecraft launcher with its own design and features.

This project is still in early development, so some features may be incomplete, change over time, or contain bugs.

 <table>
  <tr>
    <td width="33%">
      <img src="screenshot/1.png" width="100%" alt="Arca Launcher screenshot 1">
    </td>
    <td width="33%">
      <img src="screenshot/2.png" width="100%" alt="Arca Launcher screenshot 2">
    </td>
    <td width="33%">
      <img src="screenshot/3.png" width="100%" alt="Arca Launcher screenshot 3">
    </td>
  </tr>
</table>

Features

- Custom Design — A unique interface designed specifically for Arca-Launcher.
- Custom Instances — Create instances with your own name, description, logo, and background.
- Installed Content — View installed mods, resource packs, and shader packs for each instance, and open their folders.
- Content Downloader — Search and download mods, modpacks, resource packs, and shader packs from Modrinth and CurseForge, with relevance, download-count, and recently-updated sorting.
- Multi-Account Support — Manage Offline, Microsoft, and Ely.by accounts.
- Simple Settings — Adjust memory, system or launcher-managed Java, fullscreen launch, instance storage, and install concurrency and cleanup.
- CSS Themes — Choose a built-in theme or add a CSS-only custom theme with name and author metadata.

Custom Themes

Built-in themes live in `assets/themes/`. To add a custom theme, create a `.css` file in `launcher/themes/` next to the existing `launcher/config` folder, then select **Reload themes** in Settings. Each file can declare its display name and author in a CSS comment:

```css
/*
Name: My Theme
Author: Your Name
*/

:root {
  --bg: #101116;
  --panel: #15161d;
  --panel2: #1c1e26;
  --line: rgba(255, 255, 255, .09);
  --purple: #64748b;
  --green: #94a3b8;
  --text: #e8eaf0;
  --mute: #9a9eaa;
}
```

Custom themes are CSS only; HTML and JavaScript are not supported. To keep themes local and prevent external resource loads, `@import`, CSS `url(...)`, and `image-set(...)` are blocked, as are CSS escape sequences; files larger than 256 KB are skipped. A theme can still override layout styles, so choose **Default** in Settings if a custom theme makes the interface difficult to use.

Built With

- "Tauri" (https://tauri.app/)
- "Vite" (https://vite.dev/)
- "Rust" (https://www.rust-lang.org/)
- "TypeScript" (https://www.typescriptlang.org/)

Arca-Launcher is also my first application developed using this technology stack.

Installation

1. Go to the "Releases" page.
2. Download the latest Arca-Launcher installer for your system.
3. Run the installer and follow the on-screen instructions.
4. Launch Arca-Launcher and enjoy!

Requirements

- WebView2 Runtime — Required to run Arca-Launcher on Windows.

If WebView2 Runtime is not installed on your system, download and install it from the official Microsoft website:

"Download Microsoft Edge WebView2 Runtime" (https://developer.microsoft.com/en-us/microsoft-edge/webview2/)

Notes

- Make sure to download the correct installer from the Releases page.
- If the application fails to start, ensure that WebView2 Runtime is installed and up to date.
- Arca-Launcher is still in early development, so bugs and unexpected behavior may occur.

Bug Reports

Found a bug or have a suggestion? Feel free to report it through the project's "Issues" page.

Please include relevant details, steps to reproduce the problem, and error logs when possible. Never share passwords or authentication tokens.

Development Status

Arca-Launcher is an independent project currently in early development. Features, design, and functionality may change as the project evolves.

Thank you for checking out Arca-Launcher!

---

<p align="center">
  <strong>Arca-Launcher</strong>
  <br />
  <em>Made independently, built one step at a time.</em>
</p>
