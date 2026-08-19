/**
 * Imagen - Internal AI Image Generation Tool
 * Supports multiple models via OpenRouter API
 */

// ===== IndexedDB Storage =====
const ImagenDB = {
    dbName: 'ImagenDB',
    storeName: 'images',
    db: null,

    async open() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                resolve(this.db);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    const store = db.createObjectStore(this.storeName, { keyPath: 'id' });
                    store.createIndex('createdAt', 'createdAt', { unique: false });
                }
            };
        });
    },

    async saveImage(imageData) {
        await this.ensureOpen();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.put(imageData);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    },

    async getAllImages() {
        await this.ensureOpen();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const request = store.getAll();
            request.onsuccess = () => {
                // Sort by createdAt descending (newest first)
                const images = request.result.sort((a, b) =>
                    new Date(b.createdAt) - new Date(a.createdAt)
                );
                resolve(images);
            };
            request.onerror = () => reject(request.error);
        });
    },

    async deleteImage(id) {
        await this.ensureOpen();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.delete(id);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    },

    async clearAll() {
        await this.ensureOpen();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.clear();
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    },

    async ensureOpen() {
        if (!this.db) {
            await this.open();
        }
    }
};

// ===== State Management =====
const state = {
    apiKey: localStorage.getItem('imagen_api_key') || '',
    selectedModel: localStorage.getItem('imagen_model') || 'google/gemini-2.5-flash-image',
    imageSize: localStorage.getItem('imagen_size') || '1024x1024',
    imageQuality: localStorage.getItem('imagen_quality') || '1K',
    aspectRatio: localStorage.getItem('imagen_aspect_ratio') || '1:1',
    imageCount: parseInt(localStorage.getItem('imagen_count')) || 1,
    references: [], // Dynamic array - unlimited references
    images: [], // Will be loaded from IndexedDB
    currentImage: null,
    pendingBatches: [], // Track pending generation batches { id, prompt, count, completed, failed }
    // Extra models to send the same prompt to alongside selectedModel.
    // Empty = single-model behaviour, unchanged from before.
    comparisonModels: JSON.parse(localStorage.getItem('imagen_comparison_models') || '[]'),
    availableModels: [] // Image models discovered from OpenRouter (see loadModels)
};

// ===== Model Configurations =====
/**
 * Image models are discovered at runtime from OpenRouter's public model
 * catalogue instead of being hard-coded, so the list never goes stale.
 *
 * How it works:
 *   1. GET https://openrouter.ai/api/v1/models?output_modalities=image
 *      (public, no API key, CORS: *)
 *   2. Drop the "openrouter/auto" routers, which are not image models
 *   3. Merge in the few capabilities the API does not describe (see
 *      MODEL_CAPABILITY_OVERRIDES) and cache the result for 24 hours
 *   4. If the network call fails, fall back to FALLBACK_MODELS below
 *
 * The result is written into MODEL_CONFIGS, which keeps exactly the same
 * shape it had when it was a hard-coded object, so the rest of the app is
 * unchanged.
 */

/**
 * NOTE: the ?output_modalities=image filter is required. The unfiltered
 * /api/v1/models listing only returns models that emit text, so it silently
 * omits every image-only model (FLUX, Seedream, Qwen Image, Recraft, Grok
 * Imagine, ...) and returns just the handful of Gemini/GPT-5 models that
 * happen to emit text alongside the image. This endpoint lists only models
 * with at least one live provider, so it doubles as an availability check.
 */
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models?output_modalities=image';
const MODEL_CACHE_KEY = 'imagen_models_cache';
const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * OpenRouter bills image output per token, so a per-image figure needs a
 * tokens-per-image count. There are two conventions, and using the wrong one
 * is off by ~3x:
 *
 *   - Image-only models (modality "...->image", e.g. Seedream, FLUX, Qwen
 *     Image, Grok Imagine) bill 4175 tokens per image.
 *   - Models that emit text alongside the image (Gemini, GPT-5 Image) bill
 *     Google's standard 1290 tokens per image.
 *
 * Both figures are cross-checked against the per-image prices OpenRouter
 * shows on its own model pages. Prices vary with resolution and provider, so
 * this is a floor and is always rendered as "from ≈$x".
 */
const TOKENS_PER_IMAGE_ONLY = 4175;
const TOKENS_PER_MULTIMODAL_IMAGE = 1290;

/**
 * Capabilities that /api/v1/models does not expose. Everything here is
 * optional — a model missing from this table still works, it just uses the
 * conservative defaults in deriveModelConfig().
 *
 * Keys may be an exact model id or a prefix ending in "*".
 */
const MODEL_CAPABILITY_OVERRIDES = {
    // Gemini exposes an explicit image size / resolution control.
    'google/gemini-3-pro-image*': { maxReferences: 14 },
    'google/gemini-2.5-flash-image*': { maxReferences: 3 },
    'google/gemini-3.1-flash*': { maxReferences: 3 },
    // OpenAI's chat-style image models take a single reference image and pick
    // the output size themselves.
    'openai/gpt-5-image*': { supportsImageSize: false, maxReferences: 1 },
    'openai/gpt-5.4-image*': { supportsImageSize: false, maxReferences: 1 }
};

/**
 * Snapshot of the catalogue, used only when the live request fails (offline,
 * blocked, or OpenRouter down). Generated from /api/v1/models — refreshing it
 * is optional housekeeping, not a requirement for new models to appear.
 */
const FALLBACK_MODELS = [
    { id: 'bytedance-seed/seedream-5-0-lite', name: 'Seedream 5.0 Lite', created: 1786650094, inputModalities: ['text', 'image'], outputModalities: ['image'], imageOutputPrice: '0.00000838323353293413' },
    { id: 'bytedance-seed/seedream-5-0-pro', name: 'Seedream 5.0 Pro', created: 1786578139, inputModalities: ['text', 'image'], outputModalities: ['image'], imageOutputPrice: '0.0000107784431137725' },
    { id: 'x-ai/grok-imagine-image-2.0', name: 'Grok Imagine Image 2.0', created: 1786486044, inputModalities: ['text', 'image'], outputModalities: ['image'], imageOutputPrice: '0.00000958083832335329' },
    { id: 'qwen/qwen-image-3', name: 'Qwen Image 3', created: 1785894548, inputModalities: ['text', 'image'], outputModalities: ['image'], imageOutputPrice: '0.00000718562874251497' },
    { id: 'qwen/qwen-image-3-pro', name: 'Qwen Image 3 Pro', created: 1785894548, inputModalities: ['text', 'image'], outputModalities: ['image'], imageOutputPrice: '0.00000958083832335329' },
    { id: 'microsoft/mai-image-2.5-pro', name: 'MAI-Image-2.5 Pro', created: 1784827701, inputModalities: ['text', 'image'], outputModalities: ['image'], imageOutputPrice: '0.000108' },
    { id: 'krea/krea-2-large', name: 'Krea 2 Large', created: 1784574931, inputModalities: ['text', 'image'], outputModalities: ['image'], imageOutputPrice: '0.0000143712574850299' },
    { id: 'krea/krea-2-medium', name: 'Krea 2 Medium', created: 1784574928, inputModalities: ['text', 'image'], outputModalities: ['image'], imageOutputPrice: '0.00000718562874251497' },
    { id: 'krea/krea-2-medium-turbo', name: 'Krea 2 Medium Turbo', created: 1784574923, inputModalities: ['text', 'image'], outputModalities: ['image'], imageOutputPrice: '0.00000359281437125749' },
    { id: 'google/gemini-3.1-flash-lite-image', name: 'Nano Banana 2 Lite (Gemini 3.1 Flash Lite Image)', created: 1782837225, inputModalities: ['image', 'text'], outputModalities: ['image', 'text'], imageOutputPrice: '0.00003' },
    { id: 'openai/gpt-image-2', name: 'GPT Image 2', created: 1782264714, inputModalities: ['text', 'image'], outputModalities: ['image'], imageOutputPrice: '0.00003' },
    { id: 'openai/gpt-image-1', name: 'GPT Image 1', created: 1782264713, inputModalities: ['text', 'image'], outputModalities: ['image'], imageOutputPrice: '0.00004' },
    { id: 'openai/gpt-image-1-mini', name: 'GPT Image 1 Mini', created: 1782264713, inputModalities: ['text', 'image'], outputModalities: ['image'], imageOutputPrice: '0.000008' },
    { id: 'google/gemini-3.1-flash-image', name: 'Nano Banana 2 (Gemini 3.1 Flash Image)', created: 1781754065, inputModalities: ['image', 'text'], outputModalities: ['image', 'text'], imageOutputPrice: '0.00006' },
    { id: 'google/gemini-3-pro-image', name: 'Nano Banana Pro (Gemini 3 Pro Image)', created: 1781754054, inputModalities: ['image', 'text'], outputModalities: ['image', 'text'], imageOutputPrice: '0.00012' },
    { id: 'sourceful/riverflow-v2.5-pro', name: 'Riverflow V2.5 Pro', created: 1780584991, inputModalities: ['text', 'image'], outputModalities: ['image'], imageOutputPrice: '0.0000311377245508982' },
    { id: 'sourceful/riverflow-v2.5-fast', name: 'Riverflow V2.5 Fast', created: 1780584983, inputModalities: ['text', 'image'], outputModalities: ['image'], imageOutputPrice: '0.00000455089820359281' },
    { id: 'microsoft/mai-image-2.5', name: 'MAI-Image-2.5', created: 1780424896, inputModalities: ['text', 'image'], outputModalities: ['image'], imageOutputPrice: '0.000047' },
    { id: 'x-ai/grok-imagine-image-quality', name: 'Grok Imagine Image Quality', created: 1779117584, inputModalities: ['text', 'image'], outputModalities: ['image'], imageOutputPrice: '0.0000119760479041916' },
    { id: 'recraft/recraft-v4.1-pro-vector', name: 'Recraft V4.1 Pro Vector', created: 1778707395, inputModalities: ['text', 'image'], outputModalities: ['image'], imageOutputPrice: '0.0000718562874251497' },
    { id: 'recraft/recraft-v4.1-vector', name: 'Recraft V4.1 Vector', created: 1778707392, inputModalities: ['text', 'image'], outputModalities: ['image'], imageOutputPrice: '0.0000191616766467066' },
    { id: 'recraft/recraft-v4.1-utility-pro', name: 'Recraft V4.1 Utility Pro', created: 1778707389, inputModalities: ['text', 'image'], outputModalities: ['image'], imageOutputPrice: '0.0000502994011976048' },
    { id: 'recraft/recraft-v4.1-utility', name: 'Recraft V4.1 Utility', created: 1778707387, inputModalities: ['text', 'image'], outputModalities: ['image'], imageOutputPrice: '0.00000838323353293413' },
    { id: 'recraft/recraft-v4.1-pro', name: 'Recraft V4.1 Pro', created: 1778707384, inputModalities: ['text', 'image'], outputModalities: ['image'], imageOutputPrice: '0.0000502994011976048' },
    { id: 'recraft/recraft-v4.1', name: 'Recraft V4.1', created: 1778707381, inputModalities: ['text', 'image'], outputModalities: ['image'], imageOutputPrice: '0.00000838323353293413' },
    { id: 'recraft/recraft-v4-pro-vector', name: 'Recraft V4 Pro Vector', created: 1778707334, inputModalities: ['text', 'image'], outputModalities: ['image'], imageOutputPrice: '0.0000718562874251497' },
    { id: 'recraft/recraft-v4-vector', name: 'Recraft V4 Vector', created: 1778707333, inputModalities: ['text', 'image'], outputModalities: ['image'], imageOutputPrice: '0.0000191616766467066' },
    { id: 'recraft/recraft-v4-pro', name: 'Recraft V4 Pro', created: 1778185441, inputModalities: ['text', 'image'], outputModalities: ['image'], imageOutputPrice: '0.0000598802395209581' },
    { id: 'recraft/recraft-v4', name: 'Recraft V4', created: 1778185437, inputModalities: ['text', 'image'], outputModalities: ['image'], imageOutputPrice: '0.00000958083832335329' },
    { id: 'recraft/recraft-v3', name: 'Recraft V3', created: 1778185433, inputModalities: ['text', 'image'], outputModalities: ['image'], imageOutputPrice: '0.00000958083832335329' },
    { id: 'openai/gpt-5.4-image-2', name: 'GPT-5.4 Image 2', created: 1776797528, inputModalities: ['image', 'text', 'file'], outputModalities: ['image', 'text'], imageOutputPrice: '0.00003' },
    { id: 'google/gemini-3.1-flash-image-preview', name: 'Nano Banana 2 (Gemini 3.1 Flash Image Preview)', created: 1772119558, inputModalities: ['image', 'text'], outputModalities: ['image', 'text'], imageOutputPrice: '0.00006' },
    { id: 'sourceful/riverflow-v2-pro', name: 'Riverflow V2 Pro', created: 1770051427, inputModalities: ['text', 'image'], outputModalities: ['image'], imageOutputPrice: '0.0000359281437125749' },
    { id: 'sourceful/riverflow-v2-fast', name: 'Riverflow V2 Fast', created: 1770051423, inputModalities: ['text', 'image'], outputModalities: ['image'], imageOutputPrice: '0.00000479041916167665' },
    { id: 'black-forest-labs/flux.2-klein-4b', name: 'FLUX.2 Klein 4B', created: 1768429228, inputModalities: ['text', 'image'], outputModalities: ['image'], imageOutputPrice: '0.00000341796875' },
    { id: 'bytedance-seed/seedream-4.5', name: 'Seedream 4.5', created: 1766519506, inputModalities: ['image', 'text'], outputModalities: ['image'], imageOutputPrice: '0.00000958083832335329' },
    { id: 'black-forest-labs/flux.2-max', name: 'FLUX.2 Max', created: 1765857570, inputModalities: ['text', 'image'], outputModalities: ['image'], imageOutputPrice: '0.00001708984375' },
    { id: 'black-forest-labs/flux.2-flex', name: 'FLUX.2 Flex', created: 1764045987, inputModalities: ['text', 'image'], outputModalities: ['image'], imageOutputPrice: '0.0000146484375' },
    { id: 'black-forest-labs/flux.2-pro', name: 'FLUX.2 Pro', created: 1764030274, inputModalities: ['text', 'image'], outputModalities: ['image'], imageOutputPrice: '0.00000732421875' },
    { id: 'google/gemini-3-pro-image-preview', name: 'Nano Banana Pro (Gemini 3 Pro Image Preview)', created: 1763653797, inputModalities: ['image', 'text'], outputModalities: ['image', 'text'], imageOutputPrice: '0.00012' },
    { id: 'openai/gpt-5-image-mini', name: 'GPT-5 Image Mini', created: 1760624583, inputModalities: ['file', 'image', 'text'], outputModalities: ['image', 'text'], imageOutputPrice: '0.000008' },
    { id: 'openai/gpt-5-image', name: 'GPT-5 Image', created: 1760447986, inputModalities: ['image', 'text', 'file'], outputModalities: ['image', 'text'], imageOutputPrice: '0.00004' },
    { id: 'google/gemini-2.5-flash-image', name: 'Nano Banana (Gemini 2.5 Flash Image)', created: 1759870431, inputModalities: ['image', 'text'], outputModalities: ['image', 'text'], imageOutputPrice: '0.00003' },
];

/**
 * Populated by loadModels(). Same shape as the old hard-coded object:
 *   { name, supportsImageSize, supportsAspectRatio, supportsImageInput,
 *     maxReferences, pricePerImage }
 */
const MODEL_CONFIGS = {};

/** Look up any overrides registered for a model id. */
function getModelOverrides(modelId) {
    if (MODEL_CAPABILITY_OVERRIDES[modelId]) {
        return MODEL_CAPABILITY_OVERRIDES[modelId];
    }
    for (const [pattern, overrides] of Object.entries(MODEL_CAPABILITY_OVERRIDES)) {
        if (pattern.endsWith('*') && modelId.startsWith(pattern.slice(0, -1))) {
            return overrides;
        }
    }
    return {};
}

/**
 * Release month shown against each model, from the catalogue's `created`
 * timestamp — the same date OpenRouter shows on its own model pages.
 */
function formatReleaseDate(created) {
    if (!Number.isFinite(created) || created <= 0) return '';
    const date = new Date(created * 1000);
    if (isNaN(date.getTime())) return '';
    return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** Turn one catalogue entry into the config shape the app expects. */
function deriveModelConfig(model) {
    const inputModalities = model.inputModalities || [];
    const outputModalities = model.outputModalities || [];
    const supportsImageInput = inputModalities.includes('image');
    const price = parseFloat(model.imageOutputPrice);

    // Models that only emit an image bill a different tokens-per-image rate
    // than those that emit text alongside it. See the constants above.
    const imageOnly = !outputModalities.includes('text');
    const tokensPerImage = imageOnly ? TOKENS_PER_IMAGE_ONLY : TOKENS_PER_MULTIMODAL_IMAGE;

    const config = {
        name: model.name || model.id,
        // Only Gemini currently accepts an explicit image size / resolution.
        supportsImageSize: model.id.includes('gemini'),
        supportsAspectRatio: true,
        supportsImageInput: supportsImageInput,
        maxReferences: supportsImageInput ? 3 : 0,
        pricePerImage: Number.isFinite(price) ? price * tokensPerImage : null,
        created: Number.isFinite(model.created) ? model.created : null,
        releaseLabel: formatReleaseDate(model.created)
    };

    return Object.assign(config, getModelOverrides(model.id));
}

function extractImageModels(apiPayload) {
    const models = (apiPayload && apiPayload.data) || [];
    return models
        // The endpoint already restricts this to image models with a live
        // provider; the routers are the only thing that needs excluding.
        .filter(m => m && typeof m.id === 'string' && !m.id.startsWith('openrouter/'))
        .map(m => ({
            id: m.id,
            // Strip the "Google: " / "xAI: " vendor prefix; it is already
            // implied by the model id shown underneath.
            name: (m.name || m.id).split(': ').pop(),
            created: m.created,
            inputModalities: (m.architecture && m.architecture.input_modalities) || [],
            outputModalities: (m.architecture && m.architecture.output_modalities) || [],
            imageOutputPrice: (m.pricing && m.pricing.image_output) || null
        }))
        // Newest first, so the most recent models are at the top of the picker.
        .sort((a, b) => (b.created || 0) - (a.created || 0));
}

function readModelCache() {
    try {
        const raw = localStorage.getItem(MODEL_CACHE_KEY);
        if (!raw) return null;
        const cached = JSON.parse(raw);
        if (!cached || !Array.isArray(cached.models) || !cached.models.length) return null;
        if (Date.now() - cached.fetchedAt > MODEL_CACHE_TTL_MS) return null;
        return cached.models;
    } catch (error) {
        return null;
    }
}

function writeModelCache(models) {
    try {
        localStorage.setItem(MODEL_CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), models }));
    } catch (error) {
        // A full or unavailable localStorage is not fatal — we just refetch.
        console.warn('Could not cache model list:', error);
    }
}

/**
 * Resolve the model list and populate MODEL_CONFIGS.
 * Order of preference: fresh cache -> live API -> bundled fallback.
 *
 * @param {boolean} forceRefresh Skip the cache (used by the refresh button).
 * @returns {Promise<{models: Array, source: string}>}
 */
async function loadModels(forceRefresh = false) {
    let models = forceRefresh ? null : readModelCache();
    let source = 'cache';

    if (!models) {
        try {
            const response = await fetch(OPENROUTER_MODELS_URL, {
                headers: { 'Accept': 'application/json' }
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const payload = await response.json();
            const discovered = extractImageModels(payload);
            if (!discovered.length) throw new Error('No image models in response');
            models = discovered;
            source = 'api';
            writeModelCache(models);
        } catch (error) {
            console.warn('Could not load models from OpenRouter, using bundled list:', error);
            models = FALLBACK_MODELS;
            source = 'fallback';
        }
    }

    state.availableModels = models;
    Object.keys(MODEL_CONFIGS).forEach(key => delete MODEL_CONFIGS[key]);
    models.forEach(model => {
        MODEL_CONFIGS[model.id] = deriveModelConfig(model);
    });

    return { models, source };
}

// ===== DOM Elements =====
const elements = {
    // Sidebar
    modelSelectContainer: document.getElementById('modelSelectContainer'),
    modelSelectTrigger: document.getElementById('modelSelectTrigger'),
    modelSelectValue: document.getElementById('modelSelectValue'),
    modelSelectOptions: document.getElementById('modelSelectOptions'),
    modelOptionsList: document.getElementById('modelOptionsList'),
    modelSearch: document.getElementById('modelSearch'),
    modelSourceNote: document.getElementById('modelSourceNote'),
    refreshModels: document.getElementById('refreshModels'),
    geminiOptions: document.getElementById('geminiOptions'),
    apiKey: document.getElementById('apiKey'),
    saveApiKey: document.getElementById('saveApiKey'),
    imageCount: document.getElementById('imageCount'),
    decreaseCount: document.getElementById('decreaseCount'),
    increaseCount: document.getElementById('increaseCount'),
    clearReferences: document.getElementById('clearReferences'),
    referenceSlots: document.getElementById('referenceSlots'),

    // Main Content
    promptInput: document.getElementById('promptInput'),
    charCount: document.getElementById('charCount'),
    generateBtn: document.getElementById('generateBtn'),
    gallery: document.getElementById('gallery'),
    galleryEmpty: document.getElementById('galleryEmpty'),
    clearGallery: document.getElementById('clearGallery'),

    // Modal
    imageModal: document.getElementById('imageModal'),
    modalOverlay: document.getElementById('modalOverlay'),
    modalClose: document.getElementById('modalClose'),
    modalImage: document.getElementById('modalImage'),
    modalMetadata: document.getElementById('modalMetadata'),
    useAsReference: document.getElementById('useAsReference'),
    recreateImage: document.getElementById('recreateImage'),
    downloadImage: document.getElementById('downloadImage')
};

// ===== Model Picker =====
/** Format an estimated per-image price for display. */
function formatPricePerImage(pricePerImage) {
    if (!Number.isFinite(pricePerImage) || pricePerImage <= 0) return '';
    // Sub-cent models would render as "$0.00", so give them more precision.
    const decimals = pricePerImage < 0.01 ? 4 : 3;
    return `≈$${pricePerImage.toFixed(decimals)}/image`;
}

/** Primary model first, then any comparison models, de-duplicated. */
function getActiveModelIds() {
    return [state.selectedModel, ...state.comparisonModels]
        .filter((id, i, arr) => id && arr.indexOf(id) === i);
}

const MAX_COMPARISON_MODELS = 2; // primary + 2 = 3 models at once

function persistComparisonModels() {
    localStorage.setItem('imagen_comparison_models', JSON.stringify(state.comparisonModels));
}

/** Add/remove a model from the comparison set. */
function toggleComparisonModel(modelId) {
    if (modelId === state.selectedModel) return;

    const index = state.comparisonModels.indexOf(modelId);
    if (index !== -1) {
        state.comparisonModels.splice(index, 1);
    } else {
        if (state.comparisonModels.length >= MAX_COMPARISON_MODELS) {
            showToast(`You can compare up to ${MAX_COMPARISON_MODELS + 1} models at once`, 'warning');
            return;
        }
        state.comparisonModels.push(modelId);
    }
    persistComparisonModels();
    renderModelOptions(elements.modelSearch ? elements.modelSearch.value : '');
    updateModelSummary();
}

/** Drop comparison models that are no longer in the catalogue. */
function pruneComparisonModels() {
    const before = state.comparisonModels.length;
    state.comparisonModels = state.comparisonModels
        .filter(id => MODEL_CONFIGS[id] && id !== state.selectedModel);
    if (state.comparisonModels.length !== before) persistComparisonModels();
}

/** Trigger label reflects how many models the prompt will go to. */
function updateModelSummary() {
    const primary = MODEL_CONFIGS[state.selectedModel];
    if (!primary) return;
    const extra = state.comparisonModels.length;
    elements.modelSelectValue.textContent = extra
        ? `${primary.name} + ${extra} more`
        : primary.name;

    if (elements.generateBtn) {
        const total = state.imageCount * getActiveModelIds().length;
        elements.generateBtn.textContent = extra
            ? `Generate ${total} across ${extra + 1} models`
            : 'Generate';
    }
}

/** Build the option list in the dropdown from MODEL_CONFIGS. */
function renderModelOptions(filterText = '') {
    if (!elements.modelOptionsList) return;

    const query = filterText.trim().toLowerCase();
    const matches = state.availableModels.filter(model => {
        if (!query) return true;
        return model.id.toLowerCase().includes(query) ||
            (MODEL_CONFIGS[model.id].name || '').toLowerCase().includes(query);
    });

    if (!matches.length) {
        elements.modelOptionsList.innerHTML =
            '<div class="model-empty">No models match that search</div>';
        return;
    }

    elements.modelOptionsList.innerHTML = matches.map(model => {
        const config = MODEL_CONFIGS[model.id];
        const price = formatPricePerImage(config.pricePerImage);
        const isPrimary = model.id === state.selectedModel;
        const isCompared = state.comparisonModels.includes(model.id);

        return `
            <div class="custom-select-option${isPrimary ? ' selected' : ''}${isCompared ? ' compared' : ''}"
                 data-value="${escapeHtml(model.id)}" role="option">
                <div class="model-option-row">
                    <span class="model-option-name">${escapeHtml(config.name)}</span>
                    <button type="button" class="model-compare-toggle${isCompared ? ' on' : ''}"
                        data-compare="${escapeHtml(model.id)}"
                        title="${isPrimary ? 'Primary model' : (isCompared ? 'Remove from comparison' : 'Also send the prompt to this model')}"
                        ${isPrimary ? 'disabled' : ''}>${isCompared ? '✓' : '+'}</button>
                </div>
                <div class="model-option-row model-option-sub">
                    ${config.releaseLabel ? `<span class="model-date" title="Added to OpenRouter">${escapeHtml(config.releaseLabel)}</span>` : ''}
                    <span class="model-option-id">${escapeHtml(model.id)}</span>
                    ${price ? `<span class="model-option-price">${escapeHtml(price)}</span>` : ''}
                </div>
            </div>`;
    }).join('');
}

/**
 * Apply a model choice everywhere: state, storage, trigger label and the
 * dependent option panels. Used by the picker and by "recreate"/"use as
 * reference", which previously each poked at the DOM themselves.
 */
function selectModel(modelId, options = {}) {
    const config = MODEL_CONFIGS[modelId];
    if (!config) return false;

    state.selectedModel = modelId;
    localStorage.setItem('imagen_model', modelId);
    pruneComparisonModels();
    updateModelSummary();

    if (options.rerender !== false) {
        renderModelOptions(elements.modelSearch ? elements.modelSearch.value : '');
    }
    updateGeminiOptionsVisibility();
    return true;
}

/**
 * Make sure state.selectedModel points at a model that actually exists.
 * Protects users whose saved model has since been retired by OpenRouter.
 */
function ensureValidModelSelection() {
    if (MODEL_CONFIGS[state.selectedModel]) return;

    const previous = state.selectedModel;
    const preferred = state.availableModels.find(m => m.id.includes('gemini')) ||
        state.availableModels[0];
    if (!preferred) return;

    selectModel(preferred.id, { rerender: false });
    if (previous) {
        showToast(`"${previous}" is no longer available — switched to ${MODEL_CONFIGS[preferred.id].name}`, 'info');
    }
}

/** Load the catalogue and refresh the picker. */
async function initModelPicker(forceRefresh = false) {
    if (elements.modelSourceNote) {
        elements.modelSourceNote.textContent = 'Loading…';
    }

    const { models, source } = await loadModels(forceRefresh);
    ensureValidModelSelection();
    renderModelOptions();

    pruneComparisonModels();
    if (MODEL_CONFIGS[state.selectedModel]) {
        updateModelSummary();
    }

    if (elements.modelSourceNote) {
        const label = {
            api: 'Live from OpenRouter',
            cache: 'Cached (updates daily)',
            fallback: 'Offline — bundled list'
        }[source] || '';
        elements.modelSourceNote.textContent = `${models.length} models · ${label}`;
    }
    updateGeminiOptionsVisibility();
}

// ===== Initialization =====
async function init() {
    // Load saved API key
    if (state.apiKey) {
        elements.apiKey.value = state.apiKey;
    }

    // Render reference slots
    renderReferenceSlots();

    // Discover available image models, then restore the saved selection.
    await initModelPicker();

    // Restore saved image quality/size
    document.querySelectorAll('.btn-toggle').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.quality === state.imageQuality) {
            btn.classList.add('active');
        }
    });

    // Restore saved aspect ratio
    document.querySelectorAll('.btn-aspect').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.ratio === state.aspectRatio) {
            btn.classList.add('active');
        }
    });

    // Restore saved image count
    if (elements.imageCount) {
        elements.imageCount.value = state.imageCount;
    }

    // Load images from IndexedDB
    try {
        state.images = await ImagenDB.getAllImages();
    } catch (error) {
        console.error('Failed to load images from IndexedDB:', error);
        state.images = [];
    }

    // Render gallery
    renderGallery();

    // Set up event listeners
    setupEventListeners();

    // Initialize UI state
    updateGeminiOptionsVisibility();
}

// ===== Event Listeners =====
function setupEventListeners() {
    // Custom dropdown - toggle
    elements.modelSelectTrigger.addEventListener('click', () => {
        const isOpen = elements.modelSelectContainer.classList.toggle('open');
        elements.modelSelectTrigger.setAttribute('aria-expanded', String(isOpen));
        if (isOpen) {
            elements.modelSearch.value = '';
            renderModelOptions();
            elements.modelSearch.focus();
        }
    });

    // Custom dropdown - option selection (delegated: options are rebuilt
    // whenever the catalogue loads or the search box is typed in).
    elements.modelOptionsList.addEventListener('click', (e) => {
        // The "+" button adds the model to the comparison set instead of
        // making it primary, and leaves the dropdown open.
        const compareBtn = e.target.closest('.model-compare-toggle');
        if (compareBtn) {
            e.stopPropagation();
            toggleComparisonModel(compareBtn.dataset.compare);
            return;
        }

        const option = e.target.closest('.custom-select-option');
        if (!option) return;
        selectModel(option.dataset.value);
        elements.modelSelectContainer.classList.remove('open');
    });

    // Model search
    elements.modelSearch.addEventListener('input', () => {
        renderModelOptions(elements.modelSearch.value);
    });
    // Keep clicks in the search field from closing the dropdown
    elements.modelSearch.addEventListener('click', (e) => e.stopPropagation());

    // Manual catalogue refresh (bypasses the 24h cache)
    elements.refreshModels.addEventListener('click', async (e) => {
        e.stopPropagation();
        elements.refreshModels.disabled = true;
        try {
            await initModelPicker(true);
            showToast('Model list refreshed', 'success');
        } finally {
            elements.refreshModels.disabled = false;
        }
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (!elements.modelSelectContainer.contains(e.target)) {
            elements.modelSelectContainer.classList.remove('open');
            elements.modelSelectTrigger.setAttribute('aria-expanded', 'false');
        }
    });

    // Size toggle buttons
    document.querySelectorAll('.btn-toggle').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.btn-toggle').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            state.imageSize = btn.dataset.size;
            state.imageQuality = btn.dataset.quality;
            localStorage.setItem('imagen_size', state.imageSize);
            localStorage.setItem('imagen_quality', state.imageQuality);
        });
    });

    // Aspect ratio buttons
    document.querySelectorAll('.btn-aspect').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.btn-aspect').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            state.aspectRatio = btn.dataset.ratio;
            localStorage.setItem('imagen_aspect_ratio', state.aspectRatio);
        });
    });

    // Image count
    if (elements.decreaseCount) {
        elements.decreaseCount.addEventListener('click', () => {
            if (state.imageCount > 1) {
                state.imageCount--;
                elements.imageCount.value = state.imageCount;
                localStorage.setItem('imagen_count', state.imageCount);
        updateModelSummary();
            }
        });
    }

    if (elements.increaseCount) {
        elements.increaseCount.addEventListener('click', () => {
            if (state.imageCount < 8) {
                state.imageCount++;
                elements.imageCount.value = state.imageCount;
                localStorage.setItem('imagen_count', state.imageCount);
        updateModelSummary();
            }
        });
    }

    if (elements.imageCount) {
        elements.imageCount.addEventListener('change', (e) => {
            let val = parseInt(e.target.value);
            if (isNaN(val) || val < 1) val = 1;
            if (val > 8) val = 8;
            state.imageCount = val;
            elements.imageCount.value = val;
            localStorage.setItem('imagen_count', state.imageCount);
        updateModelSummary();
        });
    }

    // API Key
    elements.saveApiKey.addEventListener('click', () => {
        state.apiKey = elements.apiKey.value.trim();
        localStorage.setItem('imagen_api_key', state.apiKey);
        showToast('API key saved!', 'success');
    });

    // Reference images are handled by renderReferenceSlots()
    elements.clearReferences.addEventListener('click', clearAllReferences);

    // Drag & Drop for reference images
    setupDragAndDrop();

    // Prompt input
    elements.promptInput.addEventListener('input', () => {
        elements.charCount.textContent = `${elements.promptInput.value.length} chars`;
    });

    // Generate button
    elements.generateBtn.addEventListener('click', generateImages);

    // Clear gallery
    elements.clearGallery.addEventListener('click', async () => {
        if (confirm('Are you sure you want to clear all generated images?')) {
            state.images = [];
            try {
                await ImagenDB.clearAll();
            } catch (e) {
                console.warn('Could not clear IndexedDB:', e);
            }
            renderGallery();
            showToast('Gallery cleared', 'success');
        }
    });

    // Modal
    elements.modalOverlay.addEventListener('click', closeModal);
    elements.modalClose.addEventListener('click', closeModal);
    elements.useAsReference.addEventListener('click', useImageAsReference);
    elements.recreateImage.addEventListener('click', recreateImage);
    elements.downloadImage.addEventListener('click', downloadCurrentImage);

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeModal();
        if (e.key === 'Enter' && e.ctrlKey) generateImages();
    });

    // Paste images from clipboard
    document.addEventListener('paste', handlePaste);

    // Warn user before leaving if there are pending generations
    window.addEventListener('beforeunload', (e) => {
        if (state.pendingBatches.length > 0) {
            const pendingCount = state.pendingBatches.reduce((sum, batch) => {
                return sum + (batch.count - batch.completed - batch.failed);
            }, 0);
            if (pendingCount > 0) {
                e.preventDefault();
                // Modern browsers ignore custom messages, but we need to return something
                e.returnValue = `You have ${pendingCount} image(s) still generating. If you leave, they will be lost.`;
                return e.returnValue;
            }
        }
    });
}

// ===== Paste Handler =====
function handlePaste(e) {
    // Don't intercept paste if user is typing in an input field (except prompt)
    const activeEl = document.activeElement;
    if (activeEl && activeEl.tagName === 'INPUT' && activeEl.type !== 'text') {
        return;
    }

    const items = e.clipboardData?.items;
    if (!items) return;

    let imageCount = 0;
    for (const item of items) {
        if (item.type.startsWith('image/')) {
            e.preventDefault();
            const file = item.getAsFile();
            if (file) {
                const reader = new FileReader();
                reader.onload = (event) => {
                    state.references.push(event.target.result);
                    renderReferenceSlots();
                };
                reader.readAsDataURL(file);
                imageCount++;
            }
        }
    }

    if (imageCount > 0) {
        showToast(`${imageCount} image(s) pasted as reference`, 'success');
    }
}

// ===== Drag & Drop =====
function setupDragAndDrop() {
    const dropZone = elements.referenceSlots;

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, preventDefaults, false);
        document.body.addEventListener(eventName, preventDefaults, false);
    });

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => {
            dropZone.classList.add('drag-over');
        }, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => {
            dropZone.classList.remove('drag-over');
        }, false);
    });

    dropZone.addEventListener('drop', handleDrop, false);
}

function handleDrop(e) {
    const dt = e.dataTransfer;
    const files = dt.files;

    [...files].forEach(file => {
        if (file.type.startsWith('image/')) {
            const reader = new FileReader();
            reader.onload = (event) => {
                state.references.push(event.target.result);
                renderReferenceSlots();
            };
            reader.readAsDataURL(file);
        }
    });

    if (files.length > 0) {
        showToast(`${files.length} image(s) added as reference`, 'success');
    }
}

// ===== Reference Image Handling =====
function handleReferenceUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
        state.references.push(event.target.result);
        renderReferenceSlots();
    };
    reader.readAsDataURL(file);

    // Reset the input so the same file can be selected again
    e.target.value = '';
}

function renderReferenceSlots() {
    const container = document.getElementById('referenceSlots');
    container.innerHTML = '';

    // Render existing references
    state.references.forEach((ref, index) => {
        const slot = document.createElement('div');
        slot.className = 'reference-slot filled';
        slot.dataset.slot = index;
        slot.innerHTML = `
            <img src="${ref}" alt="Reference ${index + 1}">
            <button class="remove-ref" data-index="${index}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
            </button>
        `;
        container.appendChild(slot);
    });

    // Add "Add new" slot
    const addSlot = document.createElement('div');
    addSlot.className = 'reference-slot empty add-new';
    addSlot.innerHTML = `
        <span class="slot-label">+ Add</span>
        <input type="file" accept="image/*" class="reference-input" id="addReferenceInput">
    `;
    container.appendChild(addSlot);

    // Attach event listeners
    container.querySelectorAll('.remove-ref').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const index = parseInt(btn.dataset.index);
            removeReference(index);
        });
    });

    const addInput = container.querySelector('#addReferenceInput');
    if (addInput) {
        addInput.addEventListener('change', handleReferenceUpload);
    }
}

function removeReference(index) {
    state.references.splice(index, 1);
    renderReferenceSlots();
}

function clearAllReferences() {
    state.references = [];
    renderReferenceSlots();
    showToast('References cleared', 'success');
}

// ===== Image Generation =====
async function generateImages() {
    const prompt = elements.promptInput.value.trim();

    if (!prompt) {
        showToast('Please enter a prompt', 'warning');
        return;
    }

    if (!state.apiKey) {
        showToast('Please enter your OpenRouter API key', 'error');
        return;
    }

    // The prompt goes to the primary model plus any comparison models. With
    // none selected this is a single-entry list and behaves exactly as before.
    const targetModels = getActiveModelIds().filter(id => MODEL_CONFIGS[id]);
    if (!targetModels.length) {
        showToast('Selected model is unavailable — pick another from the list', 'error');
        return;
    }

    const currentReferences = state.references.length > 0 ? [...state.references] : [];
    const currentSize = state.imageSize;
    const currentQuality = state.imageQuality;
    const currentAspectRatio = state.aspectRatio;
    const imageCount = state.imageCount;

    // One batch per model so each model's placeholders and progress are
    // tracked separately in the gallery.
    const batches = targetModels.map(modelId => {
        const batch = {
            id: Date.now() + Math.random(),
            prompt: prompt,
            model: modelId,
            modelName: MODEL_CONFIGS[modelId].name,
            count: imageCount,
            completed: 0,
            failed: 0
        };
        state.pendingBatches.push(batch);
        addLoadingPlaceholders(batch, imageCount);
        return batch;
    });

    const totalRequested = imageCount * targetModels.length;
    showToast(
        targetModels.length > 1
            ? `Queued ${totalRequested} image(s) across ${targetModels.length} models`
            : `Queued ${imageCount} image(s) for generation`,
        'success'
    );

    const generateAndDisplay = async (batch, index) => {
        const modelConfig = MODEL_CONFIGS[batch.model];
        try {
            const result = await generateSingleImage(prompt, batch.model, modelConfig);
            if (result) {
                const imageData = {
                    id: Date.now() + index + Math.random(),
                    url: result,
                    prompt: prompt,
                    model: batch.model,
                    modelName: modelConfig.name,
                    size: currentSize,
                    quality: currentQuality,
                    aspectRatio: currentAspectRatio,
                    references: currentReferences,
                    createdAt: new Date().toISOString()
                };
                state.images.unshift(imageData);
                batch.completed++;

                removeOnePlaceholder(batch.id);
                prependImageCard(imageData, 0);

                ImagenDB.saveImage(imageData).catch(e => console.error('Failed to save to IndexedDB:', e));
            } else {
                batch.failed++;
                removeOnePlaceholder(batch.id);
            }
        } catch (error) {
            console.error(`Failed to generate image with ${batch.model}:`, error);
            batch.failed++;
            removeOnePlaceholder(batch.id);
        }
    };

    // Every model x every image runs concurrently.
    const promises = [];
    batches.forEach(batch => {
        for (let i = 0; i < imageCount; i++) {
            promises.push(generateAndDisplay(batch, i));
        }
    });

    await Promise.allSettled(promises);

    batches.forEach(batch => {
        const batchIndex = state.pendingBatches.findIndex(b => b.id === batch.id);
        if (batchIndex !== -1) state.pendingBatches.splice(batchIndex, 1);
    });

    const completed = batches.reduce((sum, b) => sum + b.completed, 0);
    if (completed > 0) {
        // Name the models that produced nothing, so a failure in a
        // multi-model run is not hidden by the models that succeeded.
        const failedModels = batches
            .filter(b => b.completed === 0)
            .map(b => b.modelName);
        showToast(
            failedModels.length
                ? `${completed} image(s) generated — no output from ${failedModels.join(', ')}`
                : `${completed} image(s) generated!`,
            failedModels.length ? 'warning' : 'success'
        );
    } else {
        showToast('Failed to generate images. Check console for details.', 'error');
    }
}

async function generateSingleImage(prompt, modelId, modelConfig) {
    // Build message content
    const content = [];

    // Add reference images if supported
    if (modelConfig.supportsImageInput) {
        state.references.forEach((ref, index) => {
            if (ref) {
                content.push({
                    type: 'image_url',
                    image_url: {
                        url: ref,
                        detail: 'high'
                    }
                });
            }
        });
    }

    // Add text prompt
    content.push({
        type: 'text',
        text: prompt
    });

    // Build request body
    const requestBody = {
        model: modelId,
        messages: [
            {
                role: 'user',
                content: content.length === 1 ? prompt : content
            }
        ],
        modalities: modelConfig.modalities
    };

    // Add Gemini-specific options
    if (modelConfig.supportsImageSize && modelId.includes('gemini')) {
        requestBody.image_config = {
            image_size: state.imageQuality.toLowerCase(),
            aspect_ratio: state.aspectRatio
        };
    }

    // Add aspect ratio for other models
    if (modelConfig.supportsAspectRatio && !modelId.includes('gemini')) {
        requestBody.aspect_ratio = state.aspectRatio;
    }

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${state.apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': window.location.origin,
            'X-Title': 'Imagen Internal Tool'
        },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error?.message || `API error: ${response.status}`);
    }

    const data = await response.json();

    // Extract image from response
    // OpenRouter returns images in different formats depending on the model
    const message = data.choices?.[0]?.message;

    if (!message) {
        throw new Error('No response from model');
    }

    // Log full response for debugging
    console.log('API Response:', JSON.stringify(data, null, 2));

    // Check for images array in message (OpenRouter SDK format)
    // According to OpenRouter docs: message.images[].image_url.url
    if (message.images && message.images.length > 0) {
        const img = message.images[0];
        // OpenRouter SDK format: { image_url: { url: "data:image/..." } }
        if (img.image_url?.url) {
            return img.image_url.url;
        }
        // Alternative formats
        if (typeof img === 'string') {
            if (img.startsWith('data:') || img.startsWith('http')) {
                return img;
            }
            return `data:image/png;base64,${img}`;
        }
        if (img.url) return img.url;
        if (img.b64_json) return `data:image/png;base64,${img.b64_json}`;
    }

    // Check for image in content parts (different models may use this format)
    if (Array.isArray(message.content)) {
        for (const part of message.content) {
            // OpenAI-style image_url part
            if (part.type === 'image_url' && part.image_url?.url) {
                return part.image_url.url;
            }
            // Gemini-style inlineData part
            if (part.inlineData?.data) {
                const mimeType = part.inlineData.mimeType || 'image/png';
                return `data:${mimeType};base64,${part.inlineData.data}`;
            }
            // Generic image part
            if (part.type === 'image' && part.image) {
                if (part.image.startsWith('data:')) {
                    return part.image;
                }
                return `data:image/png;base64,${part.image}`;
            }
        }
    }

    // Check if content itself is the image data (some models return this way)
    if (typeof message.content === 'string' && message.content.startsWith('data:image')) {
        return message.content;
    }

    throw new Error('No image in response. Check console for full API response.');
}

// ===== Gallery =====
function renderGallery() {
    const hasPending = state.pendingBatches.length > 0;
    const hasImages = state.images.length > 0;

    if (!hasImages && !hasPending) {
        elements.galleryEmpty.style.display = 'flex';
        elements.gallery.innerHTML = '';
        elements.gallery.appendChild(elements.galleryEmpty);
        return;
    }

    elements.gallery.innerHTML = '';

    // Render loading placeholders for pending batches at the top
    state.pendingBatches.forEach((batch) => {
        const pendingCount = batch.count - batch.completed - batch.failed;
        for (let i = 0; i < pendingCount; i++) {
            const placeholder = document.createElement('div');
            placeholder.className = 'image-card loading-placeholder';
            const safePrompt = escapeHtml(batch.prompt);
            const truncatedPrompt = batch.prompt.length > 60 ? batch.prompt.substring(0, 60) + '...' : batch.prompt;
            placeholder.innerHTML = `
                <div class="loading-placeholder-content">
                    <div class="loading-spinner"></div>
                    <span class="loading-placeholder-text">Generating...</span>
                </div>
                <div class="image-card-overlay" style="opacity: 1;">
                    <p class="image-card-prompt">${escapeHtml(truncatedPrompt)}</p>
                    <div class="image-card-meta">
                        <span class="meta-tag">${escapeHtml(batch.modelName)}</span>
                        <span class="meta-tag loading-tag">
                            <svg class="spin-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <line x1="12" y1="2" x2="12" y2="6"></line>
                                <line x1="12" y1="18" x2="12" y2="22"></line>
                                <line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line>
                                <line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line>
                                <line x1="2" y1="12" x2="6" y2="12"></line>
                                <line x1="18" y1="12" x2="22" y2="12"></line>
                                <line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line>
                                <line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line>
                            </svg>
                            Pending
                        </span>
                    </div>
                </div>
            `;
            elements.gallery.appendChild(placeholder);
        }
    });

    // Render existing images
    state.images.forEach((image, index) => {
        const card = document.createElement('div');
        card.className = 'image-card';

        // Sanitize URL - only allow data URIs and https URLs
        const safeUrl = sanitizeImageUrl(image.url);
        const safePrompt = escapeHtml(image.prompt);

        card.innerHTML = `
            <div class="image-card-actions image-card-actions-top">
                <button class="image-card-btn image-card-download" data-index="${index}" title="Download image">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                        <polyline points="7 10 12 15 17 10"></polyline>
                        <line x1="12" y1="15" x2="12" y2="3"></line>
                    </svg>
                </button>
                <button class="image-card-btn image-card-delete" data-index="${index}" title="Delete image">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="3 6 5 6 21 6"></polyline>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        <line x1="10" y1="11" x2="10" y2="17"></line>
                        <line x1="14" y1="11" x2="14" y2="17"></line>
                    </svg>
                </button>
            </div>
            <div class="image-card-actions image-card-actions-bottom">
                <button class="image-card-btn image-card-reference" data-index="${index}" title="Use as reference">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
                        <circle cx="12" cy="10" r="3"></circle>
                    </svg>
                </button>
                <button class="image-card-btn image-card-recreate" data-index="${index}" title="Recreate with same settings">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="23 4 23 10 17 10"></polyline>
                        <polyline points="1 20 1 14 7 14"></polyline>
                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
                    </svg>
                </button>
            </div>
            <img src="${safeUrl}" alt="${safePrompt}" loading="lazy">
            <div class="image-card-overlay">
                <p class="image-card-prompt">${safePrompt}</p>
                <div class="image-card-meta">
                    <span class="meta-tag">${escapeHtml(image.modelName || image.model)}</span>
                    <span class="meta-tag">${escapeHtml(image.quality || image.size)}</span>
                    <span class="meta-tag">${escapeHtml(image.aspectRatio)}</span>
                </div>
            </div>
        `;

        // Download button handler
        const downloadBtn = card.querySelector('.image-card-download');
        downloadBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            downloadImageByIndex(index);
        });

        // Delete button handler
        const deleteBtn = card.querySelector('.image-card-delete');
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteImage(index);
        });

        // Reference button handler
        const referenceBtn = card.querySelector('.image-card-reference');
        referenceBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            addImageAsReference(index);
        });

        // Recreate button handler
        const recreateBtn = card.querySelector('.image-card-recreate');
        recreateBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            recreateImageByIndex(index);
        });

        // Open modal on card click
        card.addEventListener('click', () => openModal(image));
        elements.gallery.appendChild(card);
    });
}

// ===== Incremental Gallery Updates =====
function addLoadingPlaceholders(batch, count) {
    // Hide empty state if showing
    elements.galleryEmpty.style.display = 'none';
    
    for (let i = 0; i < count; i++) {
        const placeholder = createPlaceholderElement(batch);
        elements.gallery.insertBefore(placeholder, elements.gallery.firstChild);
    }
}

function createPlaceholderElement(batch) {
    const placeholder = document.createElement('div');
    placeholder.className = 'image-card loading-placeholder';
    placeholder.dataset.batchId = batch.id;
    const truncatedPrompt = batch.prompt.length > 60 ? batch.prompt.substring(0, 60) + '...' : batch.prompt;
    placeholder.innerHTML = `
        <div class="loading-placeholder-content">
            <div class="loading-spinner"></div>
            <span class="loading-placeholder-text">Generating...</span>
        </div>
        <div class="image-card-overlay" style="opacity: 1;">
            <p class="image-card-prompt">${escapeHtml(truncatedPrompt)}</p>
            <div class="image-card-meta">
                <span class="meta-tag">${escapeHtml(batch.modelName)}</span>
                <span class="meta-tag loading-tag">
                    <svg class="spin-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="12" y1="2" x2="12" y2="6"></line>
                        <line x1="12" y1="18" x2="12" y2="22"></line>
                        <line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line>
                        <line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line>
                        <line x1="2" y1="12" x2="6" y2="12"></line>
                        <line x1="18" y1="12" x2="22" y2="12"></line>
                        <line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line>
                        <line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line>
                    </svg>
                    Pending
                </span>
            </div>
        </div>
    `;
    return placeholder;
}

function removeOnePlaceholder(batchId) {
    const placeholder = elements.gallery.querySelector(`.loading-placeholder[data-batch-id="${batchId}"]`);
    if (placeholder) {
        placeholder.remove();
    }
    
    // Show empty state if gallery is now empty
    if (elements.gallery.children.length === 0 || 
        (elements.gallery.children.length === 1 && elements.gallery.contains(elements.galleryEmpty))) {
        elements.galleryEmpty.style.display = 'flex';
        if (!elements.gallery.contains(elements.galleryEmpty)) {
            elements.gallery.appendChild(elements.galleryEmpty);
        }
    }
}

function prependImageCard(image, index) {
    const card = createImageCardElement(image, index);
    
    // Insert after any remaining placeholders
    const firstNonPlaceholder = elements.gallery.querySelector('.image-card:not(.loading-placeholder)');
    if (firstNonPlaceholder) {
        elements.gallery.insertBefore(card, firstNonPlaceholder);
    } else {
        elements.gallery.appendChild(card);
    }
    
    // Update indices on existing cards since we prepended
    updateCardIndices();
}

function createImageCardElement(image, index) {
    const card = document.createElement('div');
    card.className = 'image-card';
    card.dataset.imageId = image.id;

    const safeUrl = sanitizeImageUrl(image.url);
    const safePrompt = escapeHtml(image.prompt);

    card.innerHTML = `
        <div class="image-card-actions image-card-actions-top">
            <button class="image-card-btn image-card-download" title="Download image">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="7 10 12 15 17 10"></polyline>
                    <line x1="12" y1="15" x2="12" y2="3"></line>
                </svg>
            </button>
            <button class="image-card-btn image-card-delete" title="Delete image">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    <line x1="10" y1="11" x2="10" y2="17"></line>
                    <line x1="14" y1="11" x2="14" y2="17"></line>
                </svg>
            </button>
        </div>
        <div class="image-card-actions image-card-actions-bottom">
            <button class="image-card-btn image-card-reference" title="Use as reference">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
                    <circle cx="12" cy="10" r="3"></circle>
                </svg>
            </button>
            <button class="image-card-btn image-card-recreate" title="Recreate with same settings">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="23 4 23 10 17 10"></polyline>
                    <polyline points="1 20 1 14 7 14"></polyline>
                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
                </svg>
            </button>
        </div>
        <img src="${safeUrl}" alt="${safePrompt}" loading="lazy">
        <div class="image-card-overlay">
            <p class="image-card-prompt">${safePrompt}</p>
            <div class="image-card-meta">
                <span class="meta-tag">${escapeHtml(image.modelName || image.model)}</span>
                <span class="meta-tag">${escapeHtml(image.quality || image.size)}</span>
                <span class="meta-tag">${escapeHtml(image.aspectRatio)}</span>
            </div>
        </div>
    `;

    // Attach event handlers
    attachImageCardHandlers(card, image);
    
    return card;
}

function attachImageCardHandlers(card, image) {
    const imageId = image.id;
    
    card.querySelector('.image-card-download').addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = state.images.findIndex(img => img.id === imageId);
        if (idx !== -1) downloadImageByIndex(idx);
    });

    card.querySelector('.image-card-delete').addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = state.images.findIndex(img => img.id === imageId);
        if (idx !== -1) deleteImage(idx);
    });

    card.querySelector('.image-card-reference').addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = state.images.findIndex(img => img.id === imageId);
        if (idx !== -1) addImageAsReference(idx);
    });

    card.querySelector('.image-card-recreate').addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = state.images.findIndex(img => img.id === imageId);
        if (idx !== -1) recreateImageByIndex(idx);
    });

    card.addEventListener('click', () => {
        const idx = state.images.findIndex(img => img.id === imageId);
        if (idx !== -1) openModal(state.images[idx]);
    });
}

function updateCardIndices() {
    // No longer needed since we use image IDs instead of indices
}

async function deleteImage(index) {
    const imageToDelete = state.images[index];
    state.images.splice(index, 1);

    try {
        await ImagenDB.deleteImage(imageToDelete.id);
    } catch (e) {
        console.warn('Could not delete from IndexedDB:', e);
    }

    // Remove card from DOM without full re-render
    const card = elements.gallery.querySelector(`.image-card[data-image-id="${imageToDelete.id}"]`);
    if (card) {
        card.remove();
    }
    
    // Show empty state if gallery is now empty
    if (state.images.length === 0 && state.pendingBatches.length === 0) {
        elements.galleryEmpty.style.display = 'flex';
        if (!elements.gallery.contains(elements.galleryEmpty)) {
            elements.gallery.appendChild(elements.galleryEmpty);
        }
    }
    
    showToast('Image deleted', 'success');
}

function downloadImageByIndex(index) {
    const image = state.images[index];
    if (!image) return;

    const link = document.createElement('a');
    link.href = image.url;
    const timestamp = new Date(image.createdAt).toISOString().replace(/[:.]/g, '-');
    const ext = getImageExtension(image.url);
    link.download = `imagen-${timestamp}.${ext}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast('Image downloaded', 'success');
}

function addImageAsReference(index) {
    const image = state.images[index];
    if (!image) return;

    state.references.push(image.url);
    renderReferenceSlots();
    showToast('Image added as reference', 'success');
}

function recreateImageByIndex(index) {
    const image = state.images[index];
    if (!image) return;

    // Restore prompt
    elements.promptInput.value = image.prompt;
    elements.charCount.textContent = `${image.prompt.length} chars`;

    // Restore model. If it has since been retired from OpenRouter the current
    // selection is kept rather than silently switching to an unrelated model.
    if (!selectModel(image.model)) {
        showToast(`Model "${image.model}" is no longer available — keeping current selection`, 'info');
    }

    // Restore quality/size
    document.querySelectorAll('.btn-toggle').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.quality === image.quality) {
            btn.classList.add('active');
        }
    });

    // Restore aspect ratio
    document.querySelectorAll('.btn-aspect').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.ratio === image.aspectRatio) {
            btn.classList.add('active');
        }
    });

    // Restore references
    if (image.references && image.references.length > 0) {
        state.references = [...image.references];
    } else {
        state.references = [];
    }
    renderReferenceSlots();

    showToast('Settings restored. Click Generate to recreate.', 'success');

    // Scroll to top
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ===== Modal =====
function openModal(image) {
    state.currentImage = image;
    elements.modalImage.src = sanitizeImageUrl(image.url);
    elements.modalMetadata.innerHTML = `
        <p><strong>Prompt:</strong> ${escapeHtml(image.prompt)}</p>
        <p><strong>Model:</strong> ${escapeHtml(image.modelName || image.model)}</p>
        <p><strong>Size/Quality:</strong> ${escapeHtml(image.quality || image.size)}</p>
        <p><strong>Aspect Ratio:</strong> ${escapeHtml(image.aspectRatio)}</p>
        <p><strong>Created:</strong> ${escapeHtml(new Date(image.createdAt).toLocaleString())}</p>
        ${image.references?.length > 0 ? `<p><strong>References Used:</strong> ${escapeHtml(image.references.length)}</p>` : ''}
    `;
    elements.imageModal.classList.add('active');
}

function closeModal() {
    elements.imageModal.classList.remove('active');
    state.currentImage = null;
}

function useImageAsReference() {
    if (!state.currentImage) return;

    state.references.push(state.currentImage.url);
    renderReferenceSlots();
    closeModal();
    showToast('Image added as reference', 'success');
}

function recreateImage() {
    if (!state.currentImage) return;

    // Restore prompt
    elements.promptInput.value = state.currentImage.prompt;
    elements.charCount.textContent = `${state.currentImage.prompt.length} chars`;

    // Restore model. If it has since been retired from OpenRouter the current
    // selection is kept rather than silently switching to an unrelated model.
    if (!selectModel(state.currentImage.model)) {
        showToast(`Model "${state.currentImage.model}" is no longer available — keeping current selection`, 'info');
    }

    // Restore quality/size
    document.querySelectorAll('.btn-toggle').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.quality === state.currentImage.quality) {
            btn.classList.add('active');
            state.imageSize = btn.dataset.size;
            state.imageQuality = btn.dataset.quality;
        }
    });

    // Restore aspect ratio
    document.querySelectorAll('.btn-aspect').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.ratio === state.currentImage.aspectRatio) {
            btn.classList.add('active');
            state.aspectRatio = state.currentImage.aspectRatio;
        }
    });

    // Restore references (always update the UI, even if empty to clear previous refs)
    if (state.currentImage.references && state.currentImage.references.length > 0) {
        state.references = [...state.currentImage.references];
    } else {
        state.references = [];
    }
    renderReferenceSlots();

    closeModal();
    showToast('Settings restored. Click Generate to recreate.', 'success');

    // Scroll to top
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function downloadCurrentImage() {
    if (!state.currentImage) return;

    const link = document.createElement('a');
    link.href = state.currentImage.url;
    const ext = getImageExtension(state.currentImage.url);
    link.download = `imagen_${state.currentImage.id}.${ext}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast('Download started', 'success');
}

// ===== UI Helpers =====
function updateGeminiOptionsVisibility() {
    const isGemini = state.selectedModel.includes('gemini');
    elements.geminiOptions.style.display = isGemini ? 'flex' : 'none';
}

function showToast(message, type = 'info') {
    let container = document.querySelector('.toast-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'toast-container';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'slideIn 0.3s ease reverse';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function escapeHtml(text) {
    if (text == null) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}

function getImageExtension(url) {
    if (!url) return 'png';
    
    // Check for data URL with mime type
    if (url.startsWith('data:image/')) {
        const mimeMatch = url.match(/^data:image\/(\w+)/);
        if (mimeMatch) {
            const mime = mimeMatch[1].toLowerCase();
            // Map common mime types to extensions
            if (mime === 'jpeg') return 'jpg';
            if (mime === 'png') return 'png';
            if (mime === 'gif') return 'gif';
            if (mime === 'webp') return 'webp';
            if (mime === 'svg+xml') return 'svg';
            return mime;
        }
    }
    
    // Check URL extension
    if (url.startsWith('http')) {
        const urlPath = url.split('?')[0];
        const ext = urlPath.split('.').pop()?.toLowerCase();
        if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext)) {
            return ext === 'jpeg' ? 'jpg' : ext;
        }
    }
    
    // Default to png
    return 'png';
}

function sanitizeImageUrl(url) {
    if (!url) return '';
    // Only allow data URIs and HTTPS URLs
    if (url.startsWith('data:image/')) {
        return url;
    }
    if (url.startsWith('https://')) {
        // Escape any potential attribute-breaking characters
        return url.replace(/"/g, '%22').replace(/'/g, '%27');
    }
    // Block everything else (http, javascript:, etc.)
    console.warn('Blocked unsafe image URL:', url);
    return '';
}

// ===== Global functions for inline handlers =====
window.removeReference = removeReference;

// ===== Initialize =====
document.addEventListener('DOMContentLoaded', init);
