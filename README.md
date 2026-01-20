# Imagen - AI Image Generation Tool

A powerful client-side AI image generation tool using OpenRouter API. Generate thumbnails, artwork, and creative images with multiple state-of-the-art models.

![Imagen UI](assets/UI.webp)
![Imagen UI-1](assets/UI-1.webp)

## ✨ Features

### 🎨 Multi-Model Support
- **Gemini 2.5 Flash Image** - Google's fast image generation
- **Gemini 2.5 Flash (Preview)** - Preview version with latest features
- **Gemini 3 Pro (Preview)** - Advanced model, up to 14 reference images
- **GPT-5 Image** - OpenAI's latest image model
- **GPT-5 Image Mini** - Faster, smaller GPT-5 variant
- **Flux 2 Pro / Max / Flex / Klein** - Black Forest Labs models
- **Seedream 4.5** - ByteDance's image model
- **Riverflow V2** - Fast/Standard/Max variants

### 📐 Flexible Output Options
- **Resolution**: 1K, 2K, 4K (Gemini models)
- **Aspect Ratios**: 1:1, 16:9, 9:16, 4:3, 3:4, 3:2
- **Batch Generation**: Up to 8 images at once

### 🖼️ Reference Image Support
- Upload unlimited reference images
- Drag & drop support
- Use generated images as references
- Click X to remove individual references

### 💾 Persistent Storage
- **IndexedDB storage**
- Store hundreds of images
- Images persist across browser sessions

### 🎯 Gallery Features
- View all generated images
- Delete individual images (hover to reveal 🗑️ button)
- Click any image for full view + metadata
- Clear entire gallery option

### ♻️ Recreate Feature
- Click any image to restore its original settings
- Instantly iterate on previous generations

## 🚀 Quick Start

1. Clone this repository
2. Start a local server:
   ```bash
   python3 -m http.server 8080
   # or
   npx serve .
   ```
3. Open http://localhost:8080
4. Enter your OpenRouter API key
5. Write a prompt and click Generate!

## 🔑 Getting an OpenRouter API Key

1. Go to [OpenRouter](https://openrouter.ai/)
2. Create an account
3. Navigate to **Keys** section
4. Create a new API key
5. Copy and paste it into the tool

## 🔒 Privacy & Security

This is a **100% client-side application**:

- ✅ API keys are stored in YOUR browser only
- ✅ Generated images are stored in YOUR browser only (IndexedDB)
- ✅ No data is sent to any server except OpenRouter API
- ✅ Safe to deploy as a static website

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl + Enter` | Generate images |
| `Escape` | Close image modal |

## 🛠️ Tech Stack

- **Frontend**: Pure HTML/CSS/JavaScript (no dependencies)
- **API**: OpenRouter for model access
- **Storage**: IndexedDB for image persistence
- **Styling**: Custom CSS with CSS variables

## 📁 Project Structure

```
imagen/
├── src/            # Source code (JS/CSS)
├── assets/         # Images and design assets
├── index.html      # Main entry point
└── README.md       # Documentation
```

## 📜 License

This project is licensed under the **GNU General Public License v3.0** (GPL-3.0).

You are free to:
- ✅ Use this software for any purpose
- ✅ Study how the software works and modify it
- ✅ Distribute copies of the software
- ✅ Distribute modified versions

Under the condition that:
- 📋 You include the original license and copyright notice
- 📋 You disclose the source code when distributing
- 📋 Modified versions must also be licensed under GPL-3.0

See the [LICENSE](LICENSE) file for full details.