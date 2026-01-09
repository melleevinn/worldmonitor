import type { NewsItem, Monitor, PanelConfig, MapLayers } from '@/types';
import {
  FEEDS,
  INTEL_SOURCES,
  SECTORS,
  COMMODITIES,
  MARKET_SYMBOLS,
  REFRESH_INTERVALS,
  DEFAULT_PANELS,
  DEFAULT_MAP_LAYERS,
  STORAGE_KEYS,
} from '@/config';
import { fetchCategoryFeeds, fetchMultipleStocks, fetchCrypto, fetchPredictions, fetchEarthquakes, initDB, updateBaseline, calculateDeviation, analyzeCorrelations, clusterNews, addToSignalHistory, saveSnapshot, cleanOldSnapshots } from '@/services';
import { loadFromStorage, saveToStorage, ExportPanel } from '@/utils';
import {
  MapComponent,
  NewsPanel,
  MarketPanel,
  HeatmapPanel,
  CommoditiesPanel,
  CryptoPanel,
  PredictionPanel,
  MonitorPanel,
  Panel,
  SignalModal,
  PlaybackControl,
  StatusPanel,
} from '@/components';
import type { PredictionMarket, MarketData, ClusteredEvent } from '@/types';

export class App {
  private container: HTMLElement;
  private map: MapComponent | null = null;
  private panels: Record<string, Panel> = {};
  private newsPanels: Record<string, NewsPanel> = {};
  private allNews: NewsItem[] = [];
  private monitors: Monitor[];
  private panelSettings: Record<string, PanelConfig>;
  private mapLayers: MapLayers;
  private signalModal: SignalModal | null = null;
  private playbackControl: PlaybackControl | null = null;
  private statusPanel: StatusPanel | null = null;
  private exportPanel: ExportPanel | null = null;
  private latestPredictions: PredictionMarket[] = [];
  private latestMarkets: MarketData[] = [];
  private latestClusters: ClusteredEvent[] = [];
  private isPlaybackMode = false;

  constructor(containerId: string) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Container ${containerId} not found`);
    this.container = el;

    this.monitors = loadFromStorage<Monitor[]>(STORAGE_KEYS.monitors, []);
    this.panelSettings = loadFromStorage<Record<string, PanelConfig>>(
      STORAGE_KEYS.panels,
      DEFAULT_PANELS
    );
    this.mapLayers = loadFromStorage<MapLayers>(STORAGE_KEYS.mapLayers, DEFAULT_MAP_LAYERS);
  }

  public async init(): Promise<void> {
    await initDB();
    this.renderLayout();
    this.signalModal = new SignalModal();
    this.setupPlaybackControl();
    this.setupStatusPanel();
    this.setupExportPanel();
    this.setupEventListeners();
    await this.loadAllData();
    this.setupRefreshIntervals();
    this.setupSnapshotSaving();
    cleanOldSnapshots();
  }

  private setupStatusPanel(): void {
    this.statusPanel = new StatusPanel();
    const headerLeft = this.container.querySelector('.header-left');
    if (headerLeft) {
      headerLeft.appendChild(this.statusPanel.getElement());
    }
  }

  private setupExportPanel(): void {
    this.exportPanel = new ExportPanel(() => ({
      news: this.latestClusters.length > 0 ? this.latestClusters : this.allNews,
      markets: this.latestMarkets,
      predictions: this.latestPredictions,
      timestamp: Date.now(),
    }));

    const headerRight = this.container.querySelector('.header-right');
    if (headerRight) {
      headerRight.insertBefore(this.exportPanel.getElement(), headerRight.firstChild);
    }
  }

  private setupPlaybackControl(): void {
    this.playbackControl = new PlaybackControl();
    this.playbackControl.onSnapshot((snapshot) => {
      if (snapshot) {
        this.isPlaybackMode = true;
        this.restoreSnapshot(snapshot);
      } else {
        this.isPlaybackMode = false;
        this.loadAllData();
      }
    });

    const headerRight = this.container.querySelector('.header-right');
    if (headerRight) {
      headerRight.insertBefore(this.playbackControl.getElement(), headerRight.firstChild);
    }
  }

  private setupSnapshotSaving(): void {
    const saveCurrentSnapshot = async () => {
      if (this.isPlaybackMode) return;

      const marketPrices: Record<string, number> = {};
      this.latestMarkets.forEach(m => {
        if (m.price !== null) marketPrices[m.symbol] = m.price;
      });

      await saveSnapshot({
        timestamp: Date.now(),
        events: this.latestClusters,
        marketPrices,
        predictions: this.latestPredictions.map(p => ({
          title: p.title,
          yesPrice: p.yesPrice
        })),
        hotspotLevels: this.map?.getHotspotLevels() ?? {}
      });
    };

    saveCurrentSnapshot();
    setInterval(saveCurrentSnapshot, 15 * 60 * 1000);
  }

  private restoreSnapshot(snapshot: import('@/services/storage').DashboardSnapshot): void {
    for (const panel of Object.values(this.newsPanels)) {
      panel.showLoading();
    }

    const events = snapshot.events as ClusteredEvent[];
    this.latestClusters = events;

    const predictions = snapshot.predictions.map((p, i) => ({
      id: `snap-${i}`,
      title: p.title,
      yesPrice: p.yesPrice,
      noPrice: 1 - p.yesPrice,
      volume24h: 0,
      liquidity: 0,
    }));
    this.latestPredictions = predictions;
    (this.panels['polymarket'] as PredictionPanel).renderPredictions(predictions);

    this.map?.setHotspotLevels(snapshot.hotspotLevels);
  }

  private renderLayout(): void {
    this.container.innerHTML = `
      <div class="header">
        <div class="header-left">
          <span class="logo">WORLD MONITOR</span>
          <span class="credit">by Elie Habib</span>
          <div class="status-indicator">
            <span class="status-dot"></span>
            <span>LIVE</span>
          </div>
        </div>
        <div class="header-center">
          <button class="view-btn active" data-view="global">GLOBAL</button>
          <button class="view-btn" data-view="us">US</button>
          <button class="view-btn" data-view="mena">MENA</button>
        </div>
        <div class="header-right">
          <span class="time-display" id="timeDisplay">--:--:-- UTC</span>
          <button class="settings-btn" id="settingsBtn">⚙ PANELS</button>
        </div>
      </div>
      <div class="main-content">
        <div class="map-section" id="mapSection">
          <div class="panel-header">
            <div class="panel-header-left">
              <span class="panel-title">Global Situation</span>
            </div>
          </div>
          <div class="map-container" id="mapContainer"></div>
          <div class="map-resize-handle" id="mapResizeHandle"></div>
        </div>
        <div class="panels-grid" id="panelsGrid"></div>
      </div>
      <div class="modal-overlay" id="settingsModal">
        <div class="modal">
          <div class="modal-header">
            <span class="modal-title">Panel Settings</span>
            <button class="modal-close" id="modalClose">×</button>
          </div>
          <div class="panel-toggle-grid" id="panelToggles"></div>
        </div>
      </div>
    `;

    this.createPanels();
    this.renderPanelToggles();
    this.updateTime();
    setInterval(() => this.updateTime(), 1000);
  }

  private createPanels(): void {
    const panelsGrid = document.getElementById('panelsGrid')!;

    // Initialize map in the map section
    const mapContainer = document.getElementById('mapContainer') as HTMLElement;
    this.map = new MapComponent(mapContainer, {
      zoom: 1,
      pan: { x: 0, y: 0 },
      view: 'global',
      layers: this.mapLayers,
      timeRange: '7d',
    });

    // Create all panels
    const politicsPanel = new NewsPanel('politics', 'World / Geopolitical');
    this.newsPanels['politics'] = politicsPanel;
    this.panels['politics'] = politicsPanel;

    const techPanel = new NewsPanel('tech', 'Technology / AI');
    this.newsPanels['tech'] = techPanel;
    this.panels['tech'] = techPanel;

    const financePanel = new NewsPanel('finance', 'Financial News');
    this.newsPanels['finance'] = financePanel;
    this.panels['finance'] = financePanel;

    const heatmapPanel = new HeatmapPanel();
    this.panels['heatmap'] = heatmapPanel;

    const marketsPanel = new MarketPanel();
    this.panels['markets'] = marketsPanel;

    const monitorPanel = new MonitorPanel(this.monitors);
    this.panels['monitors'] = monitorPanel;
    monitorPanel.onChanged((monitors) => {
      this.monitors = monitors;
      saveToStorage(STORAGE_KEYS.monitors, monitors);
      this.updateMonitorResults();
    });

    const commoditiesPanel = new CommoditiesPanel();
    this.panels['commodities'] = commoditiesPanel;

    const predictionPanel = new PredictionPanel();
    this.panels['polymarket'] = predictionPanel;

    const govPanel = new NewsPanel('gov', 'Government / Policy');
    this.newsPanels['gov'] = govPanel;
    this.panels['gov'] = govPanel;

    const intelPanel = new NewsPanel('intel', 'Intel Feed');
    this.newsPanels['intel'] = intelPanel;
    this.panels['intel'] = intelPanel;

    const cryptoPanel = new CryptoPanel();
    this.panels['crypto'] = cryptoPanel;

    const middleeastPanel = new NewsPanel('middleeast', 'Middle East / MENA');
    this.newsPanels['middleeast'] = middleeastPanel;
    this.panels['middleeast'] = middleeastPanel;

    const layoffsPanel = new NewsPanel('layoffs', 'Layoffs Tracker');
    this.newsPanels['layoffs'] = layoffsPanel;
    this.panels['layoffs'] = layoffsPanel;

    const congressPanel = new NewsPanel('congress', 'Congress Trades');
    this.newsPanels['congress'] = congressPanel;
    this.panels['congress'] = congressPanel;

    const aiPanel = new NewsPanel('ai', 'AI / ML');
    this.newsPanels['ai'] = aiPanel;
    this.panels['ai'] = aiPanel;

    const thinktanksPanel = new NewsPanel('thinktanks', 'Think Tanks');
    this.newsPanels['thinktanks'] = thinktanksPanel;
    this.panels['thinktanks'] = thinktanksPanel;

    // Add panels to grid in saved order
    const defaultOrder = ['politics', 'middleeast', 'tech', 'ai', 'finance', 'layoffs', 'congress', 'heatmap', 'markets', 'commodities', 'crypto', 'polymarket', 'gov', 'thinktanks', 'intel', 'monitors'];
    const savedOrder = this.getSavedPanelOrder();
    // Merge saved order with default to include new panels
    let panelOrder = defaultOrder;
    if (savedOrder.length > 0) {
      // Add any missing panels from default that aren't in saved order
      const missing = defaultOrder.filter(k => !savedOrder.includes(k));
      // Remove any saved panels that no longer exist
      const valid = savedOrder.filter(k => defaultOrder.includes(k));
      // Insert missing panels after 'politics' (except monitors which goes at end)
      const monitorsIdx = valid.indexOf('monitors');
      if (monitorsIdx !== -1) valid.splice(monitorsIdx, 1); // Remove monitors temporarily
      const insertIdx = valid.indexOf('politics') + 1 || 0;
      const newPanels = missing.filter(k => k !== 'monitors');
      valid.splice(insertIdx, 0, ...newPanels);
      valid.push('monitors'); // Always put monitors last
      panelOrder = valid;
    }

    panelOrder.forEach((key: string) => {
      const panel = this.panels[key];
      if (panel) {
        const el = panel.getElement();
        this.makeDraggable(el, key);
        panelsGrid.appendChild(el);
      }
    });

    this.applyPanelSettings();
  }

  private getSavedPanelOrder(): string[] {
    try {
      const saved = localStorage.getItem('panel-order');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  }

  private savePanelOrder(): void {
    const grid = document.getElementById('panelsGrid');
    if (!grid) return;
    const order = Array.from(grid.children)
      .map((el) => (el as HTMLElement).dataset.panel)
      .filter((key): key is string => !!key);
    localStorage.setItem('panel-order', JSON.stringify(order));
  }

  private makeDraggable(el: HTMLElement, key: string): void {
    el.draggable = true;
    el.dataset.panel = key;

    el.addEventListener('dragstart', (e) => {
      el.classList.add('dragging');
      e.dataTransfer?.setData('text/plain', key);
    });

    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      this.savePanelOrder();
    });

    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      const dragging = document.querySelector('.dragging');
      if (!dragging || dragging === el) return;

      const grid = document.getElementById('panelsGrid');
      if (!grid) return;

      const siblings = Array.from(grid.children).filter((c) => c !== dragging);
      const nextSibling = siblings.find((sibling) => {
        const rect = sibling.getBoundingClientRect();
        return e.clientY < rect.top + rect.height / 2;
      });

      if (nextSibling) {
        grid.insertBefore(dragging, nextSibling);
      } else {
        grid.appendChild(dragging);
      }
    });
  }

  private setupEventListeners(): void {
    // View buttons
    document.querySelectorAll('.view-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.view-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const view = (btn as HTMLElement).dataset.view as 'global' | 'us' | 'mena';
        this.map?.setView(view);
      });
    });

    // Settings modal
    document.getElementById('settingsBtn')?.addEventListener('click', () => {
      document.getElementById('settingsModal')?.classList.add('active');
    });

    document.getElementById('modalClose')?.addEventListener('click', () => {
      document.getElementById('settingsModal')?.classList.remove('active');
    });

    document.getElementById('settingsModal')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('modal-overlay')) {
        (e.target as HTMLElement).classList.remove('active');
      }
    });

    // Window resize
    window.addEventListener('resize', () => {
      this.map?.render();
    });

    // Map section resize handle
    this.setupMapResize();
  }

  private setupMapResize(): void {
    const mapSection = document.getElementById('mapSection');
    const resizeHandle = document.getElementById('mapResizeHandle');
    if (!mapSection || !resizeHandle) return;

    // Load saved height
    const savedHeight = localStorage.getItem('map-height');
    if (savedHeight) {
      mapSection.style.height = savedHeight;
    }

    let isResizing = false;
    let startY = 0;
    let startHeight = 0;

    resizeHandle.addEventListener('mousedown', (e) => {
      isResizing = true;
      startY = e.clientY;
      startHeight = mapSection.offsetHeight;
      mapSection.classList.add('resizing');
      document.body.style.cursor = 'ns-resize';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      const deltaY = e.clientY - startY;
      const newHeight = Math.max(400, Math.min(startHeight + deltaY, window.innerHeight * 0.85));
      mapSection.style.height = `${newHeight}px`;
      this.map?.render();
    });

    document.addEventListener('mouseup', () => {
      if (!isResizing) return;
      isResizing = false;
      mapSection.classList.remove('resizing');
      document.body.style.cursor = '';
      // Save height preference
      localStorage.setItem('map-height', mapSection.style.height);
      this.map?.render();
    });
  }

  private renderPanelToggles(): void {
    const container = document.getElementById('panelToggles')!;
    container.innerHTML = Object.entries(this.panelSettings)
      .map(
        ([key, panel]) => `
        <div class="panel-toggle-item ${panel.enabled ? 'active' : ''}" data-panel="${key}">
          <div class="panel-toggle-checkbox">${panel.enabled ? '✓' : ''}</div>
          <span class="panel-toggle-label">${panel.name}</span>
        </div>
      `
      )
      .join('');

    container.querySelectorAll('.panel-toggle-item').forEach((item) => {
      item.addEventListener('click', () => {
        const panelKey = (item as HTMLElement).dataset.panel!;
        const config = this.panelSettings[panelKey];
        if (config) {
          config.enabled = !config.enabled;
          saveToStorage(STORAGE_KEYS.panels, this.panelSettings);
          this.renderPanelToggles();
          this.applyPanelSettings();
        }
      });
    });
  }

  private applyPanelSettings(): void {
    Object.entries(this.panelSettings).forEach(([key, config]) => {
      if (key === 'map') {
        const mapSection = document.getElementById('mapSection');
        if (mapSection) {
          mapSection.classList.toggle('hidden', !config.enabled);
        }
        return;
      }
      const panel = this.panels[key];
      panel?.toggle(config.enabled);
    });
  }

  private updateTime(): void {
    const now = new Date();
    const el = document.getElementById('timeDisplay');
    if (el) {
      el.textContent = now.toUTCString().split(' ')[4] + ' UTC';
    }
  }

  private async loadAllData(): Promise<void> {
    await Promise.all([
      this.loadNews(),
      this.loadMarkets(),
      this.loadPredictions(),
      this.loadEarthquakes(),
    ]);
  }

  private async loadNewsCategory(category: string, feeds: typeof FEEDS.politics): Promise<NewsItem[]> {
    try {
      const items = await fetchCategoryFeeds(feeds ?? []);
      const panel = this.newsPanels[category];

      if (panel) {
        panel.renderNews(items);

        const baseline = await updateBaseline(`news:${category}`, items.length);
        const deviation = calculateDeviation(items.length, baseline);
        panel.setDeviation(deviation.zScore, deviation.percentChange, deviation.level);
      }

      this.statusPanel?.updateFeed(category.charAt(0).toUpperCase() + category.slice(1), {
        status: 'ok',
        itemCount: items.length,
      });

      return items;
    } catch (error) {
      this.statusPanel?.updateFeed(category.charAt(0).toUpperCase() + category.slice(1), {
        status: 'error',
        errorMessage: String(error),
      });
      return [];
    }
  }

  private async loadNews(): Promise<void> {
    this.allNews = [];

    const categories = [
      { key: 'politics', feeds: FEEDS.politics },
      { key: 'tech', feeds: FEEDS.tech },
      { key: 'finance', feeds: FEEDS.finance },
      { key: 'gov', feeds: FEEDS.gov },
      { key: 'middleeast', feeds: FEEDS.middleeast },
      { key: 'layoffs', feeds: FEEDS.layoffs },
      { key: 'congress', feeds: FEEDS.congress },
      { key: 'ai', feeds: FEEDS.ai },
      { key: 'thinktanks', feeds: FEEDS.thinktanks },
    ];

    for (const { key, feeds } of categories) {
      const items = await this.loadNewsCategory(key, feeds);
      this.allNews.push(...items);
    }

    // Intel (uses different source)
    const intel = await fetchCategoryFeeds(INTEL_SOURCES);
    const intelPanel = this.newsPanels['intel'];
    if (intelPanel) {
      intelPanel.renderNews(intel);
      const baseline = await updateBaseline('news:intel', intel.length);
      const deviation = calculateDeviation(intel.length, baseline);
      intelPanel.setDeviation(deviation.zScore, deviation.percentChange, deviation.level);
    }
    this.allNews.push(...intel);

    // Update map hotspots
    this.map?.updateHotspotActivity(this.allNews);

    // Update monitors
    this.updateMonitorResults();

    // Update clusters for correlation analysis
    this.latestClusters = clusterNews(this.allNews);
  }

  private async loadMarkets(): Promise<void> {
    // Stocks
    const stocks = await fetchMultipleStocks(MARKET_SYMBOLS);
    this.latestMarkets = stocks;
    (this.panels['markets'] as MarketPanel).renderMarkets(stocks);

    // Sectors
    const sectors = await fetchMultipleStocks(SECTORS.map((s) => ({ ...s, display: s.name })));
    (this.panels['heatmap'] as HeatmapPanel).renderHeatmap(
      sectors.map((s) => ({ name: s.name, change: s.change }))
    );

    // Commodities
    const commodities = await fetchMultipleStocks(COMMODITIES);
    (this.panels['commodities'] as CommoditiesPanel).renderCommodities(
      commodities.map((c) => ({ display: c.display, price: c.price, change: c.change }))
    );

    // Crypto
    const crypto = await fetchCrypto();
    (this.panels['crypto'] as CryptoPanel).renderCrypto(crypto);
  }

  private async loadPredictions(): Promise<void> {
    try {
      const predictions = await fetchPredictions();
      this.latestPredictions = predictions;
      (this.panels['polymarket'] as PredictionPanel).renderPredictions(predictions);

      this.statusPanel?.updateFeed('Polymarket', { status: 'ok', itemCount: predictions.length });
      this.statusPanel?.updateApi('Polymarket', { status: 'ok' });

      this.runCorrelationAnalysis();
    } catch (error) {
      this.statusPanel?.updateFeed('Polymarket', { status: 'error', errorMessage: String(error) });
      this.statusPanel?.updateApi('Polymarket', { status: 'error' });
    }
  }

  private async loadEarthquakes(): Promise<void> {
    const earthquakes = await fetchEarthquakes();
    this.map?.setEarthquakes(earthquakes);
  }

  private updateMonitorResults(): void {
    const monitorPanel = this.panels['monitors'] as MonitorPanel;
    monitorPanel.renderResults(this.allNews);
  }

  private runCorrelationAnalysis(): void {
    if (this.latestClusters.length === 0) {
      this.latestClusters = clusterNews(this.allNews);
    }

    const signals = analyzeCorrelations(
      this.latestClusters,
      this.latestPredictions,
      this.latestMarkets
    );

    if (signals.length > 0) {
      addToSignalHistory(signals);
      this.signalModal?.show(signals);
    }
  }

  private setupRefreshIntervals(): void {
    setInterval(() => this.loadNews(), REFRESH_INTERVALS.feeds);
    setInterval(() => this.loadMarkets(), REFRESH_INTERVALS.markets);
    setInterval(() => this.loadPredictions(), REFRESH_INTERVALS.predictions);
    setInterval(() => this.loadEarthquakes(), 5 * 60 * 1000);
  }
}
