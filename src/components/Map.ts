import * as d3 from 'd3';
import * as topojson from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';
import type { MapLayers, Hotspot, NewsItem, Earthquake } from '@/types';
import {
  MAP_URLS,
  INTEL_HOTSPOTS,
  CONFLICT_ZONES,
  MILITARY_BASES,
  UNDERSEA_CABLES,
  NUCLEAR_FACILITIES,
  SANCTIONED_COUNTRIES,
  STRATEGIC_WATERWAYS,
  APT_GROUPS,
} from '@/config';
import { MapPopup } from './MapPopup';

type TimeRange = '1h' | '6h' | '24h' | '48h' | '7d' | 'all';
type MapView = 'global' | 'us' | 'mena';

interface MapState {
  zoom: number;
  pan: { x: number; y: number };
  view: MapView;
  layers: MapLayers;
  timeRange: TimeRange;
}

interface HotspotWithBreaking extends Hotspot {
  hasBreaking?: boolean;
}

interface WorldTopology extends Topology {
  objects: {
    countries: GeometryCollection;
  };
}

interface USTopology extends Topology {
  objects: {
    states: GeometryCollection;
  };
}

export class MapComponent {
  private container: HTMLElement;
  private svg: d3.Selection<SVGSVGElement, unknown, null, undefined>;
  private wrapper: HTMLElement;
  private overlays: HTMLElement;
  private state: MapState;
  private worldData: WorldTopology | null = null;
  private usData: USTopology | null = null;
  private hotspots: HotspotWithBreaking[];
  private earthquakes: Earthquake[] = [];
  private news: NewsItem[] = [];
  private popup: MapPopup;
  private onHotspotClick?: (hotspot: Hotspot) => void;
  private onTimeRangeChange?: (range: TimeRange) => void;

  constructor(container: HTMLElement, initialState: MapState) {
    this.container = container;
    this.state = initialState;
    this.hotspots = [...INTEL_HOTSPOTS];

    this.wrapper = document.createElement('div');
    this.wrapper.className = 'map-wrapper';
    this.wrapper.id = 'mapWrapper';

    const svgElement = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgElement.classList.add('map-svg');
    svgElement.id = 'mapSvg';
    this.wrapper.appendChild(svgElement);

    // Overlays inside wrapper so they transform together on zoom/pan
    this.overlays = document.createElement('div');
    this.overlays.id = 'mapOverlays';
    this.wrapper.appendChild(this.overlays);

    container.appendChild(this.wrapper);
    container.appendChild(this.createControls());
    container.appendChild(this.createTimeSlider());
    container.appendChild(this.createLayerToggles());
    container.appendChild(this.createLegend());
    container.appendChild(this.createTimestamp());

    this.svg = d3.select(svgElement);
    this.popup = new MapPopup(container);

    this.setupZoomHandlers();
    this.loadMapData();
  }

  private createControls(): HTMLElement {
    const controls = document.createElement('div');
    controls.className = 'map-controls';
    controls.innerHTML = `
      <button class="map-control-btn" data-action="zoom-in">+</button>
      <button class="map-control-btn" data-action="zoom-out">−</button>
      <button class="map-control-btn" data-action="reset">⟲</button>
    `;

    controls.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const action = target.dataset.action;
      if (action === 'zoom-in') this.zoomIn();
      else if (action === 'zoom-out') this.zoomOut();
      else if (action === 'reset') this.reset();
    });

    return controls;
  }

  private createTimeSlider(): HTMLElement {
    const slider = document.createElement('div');
    slider.className = 'time-slider';
    slider.id = 'timeSlider';

    const ranges: { value: TimeRange; label: string }[] = [
      { value: '1h', label: '1H' },
      { value: '6h', label: '6H' },
      { value: '24h', label: '24H' },
      { value: '48h', label: '48H' },
      { value: '7d', label: '7D' },
      { value: 'all', label: 'ALL' },
    ];

    slider.innerHTML = `
      <span class="time-slider-label">TIME RANGE</span>
      <div class="time-slider-buttons">
        ${ranges
          .map(
            (r) =>
              `<button class="time-btn ${this.state.timeRange === r.value ? 'active' : ''}" data-range="${r.value}">${r.label}</button>`
          )
          .join('')}
      </div>
    `;

    slider.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('time-btn')) {
        const range = target.dataset.range as TimeRange;
        this.setTimeRange(range);
        slider.querySelectorAll('.time-btn').forEach((btn) => btn.classList.remove('active'));
        target.classList.add('active');
      }
    });

    return slider;
  }

  private setTimeRange(range: TimeRange): void {
    this.state.timeRange = range;
    this.onTimeRangeChange?.(range);
    this.render();
  }

  private getTimeRangeMs(): number {
    const ranges: Record<TimeRange, number> = {
      '1h': 60 * 60 * 1000,
      '6h': 6 * 60 * 60 * 1000,
      '24h': 24 * 60 * 60 * 1000,
      '48h': 48 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
      'all': Infinity,
    };
    return ranges[this.state.timeRange];
  }

  private filterByTime<T extends { time?: Date }>(items: T[]): T[] {
    if (this.state.timeRange === 'all') return items;
    const now = Date.now();
    const cutoff = now - this.getTimeRangeMs();
    return items.filter((item) => {
      if (!item.time) return true;
      return item.time.getTime() >= cutoff;
    });
  }

  private createLayerToggles(): HTMLElement {
    const toggles = document.createElement('div');
    toggles.className = 'layer-toggles';
    toggles.id = 'layerToggles';

    const layers: (keyof MapLayers)[] = ['conflicts', 'bases', 'cables', 'hotspots', 'earthquakes', 'nuclear', 'sanctions'];

    layers.forEach((layer) => {
      const btn = document.createElement('button');
      btn.className = `layer-toggle ${this.state.layers[layer] ? 'active' : ''}`;
      btn.dataset.layer = layer;
      btn.textContent = layer;
      btn.addEventListener('click', () => this.toggleLayer(layer));
      toggles.appendChild(btn);
    });

    return toggles;
  }

  private createLegend(): HTMLElement {
    const legend = document.createElement('div');
    legend.className = 'map-legend';
    legend.innerHTML = `
      <div class="map-legend-item"><span class="legend-dot high"></span>HIGH ALERT</div>
      <div class="map-legend-item"><span class="legend-dot elevated"></span>ELEVATED</div>
      <div class="map-legend-item"><span class="legend-dot low"></span>MONITORING</div>
      <div class="map-legend-item"><span class="map-legend-icon conflict">⚔</span>CONFLICT</div>
      <div class="map-legend-item"><span class="map-legend-icon earthquake">●</span>EARTHQUAKE</div>
      <div class="map-legend-item"><span class="map-legend-icon apt">⚠</span>APT</div>
    `;
    return legend;
  }

  private createTimestamp(): HTMLElement {
    const timestamp = document.createElement('div');
    timestamp.className = 'map-timestamp';
    timestamp.id = 'mapTimestamp';
    this.updateTimestamp(timestamp);
    setInterval(() => this.updateTimestamp(timestamp), 60000);
    return timestamp;
  }

  private updateTimestamp(el: HTMLElement): void {
    const now = new Date();
    el.innerHTML = `LAST UPDATE: ${now.toUTCString().replace('GMT', 'UTC')}`;
  }

  private setupZoomHandlers(): void {
    this.container.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (e.deltaY < 0) this.zoomIn();
        else this.zoomOut();
      },
      { passive: false }
    );
  }

  private async loadMapData(): Promise<void> {
    try {
      const [worldResponse, usResponse] = await Promise.all([
        fetch(MAP_URLS.world),
        fetch(MAP_URLS.us),
      ]);

      this.worldData = await worldResponse.json();
      this.usData = await usResponse.json();

      this.render();
    } catch (e) {
      console.error('Failed to load map data:', e);
    }
  }

  public render(): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;

    this.svg.attr('viewBox', `0 0 ${width} ${height}`);
    this.svg.selectAll('*').remove();

    // Background
    this.svg
      .append('rect')
      .attr('width', width)
      .attr('height', height)
      .attr('fill', '#020a08');

    // Grid
    this.renderGrid(width, height);

    // Setup projection
    const projection = this.getProjection(width, height);
    const path = d3.geoPath().projection(projection);

    // Graticule
    this.renderGraticule(path);

    // Countries
    this.renderCountries(path);

    // Layers (show on global and mena views)
    const showGlobalLayers = this.state.view === 'global' || this.state.view === 'mena';
    if (this.state.layers.cables && showGlobalLayers) {
      this.renderCables(projection);
    }

    if (this.state.layers.conflicts && showGlobalLayers) {
      this.renderConflicts(projection);
    }

    if (this.state.layers.sanctions && showGlobalLayers) {
      this.renderSanctions();
    }

    // Overlays
    this.renderOverlays(projection);

    this.applyTransform();
  }

  private renderGrid(width: number, height: number): void {
    const gridGroup = this.svg.append('g').attr('class', 'grid');

    for (let x = 0; x < width; x += 20) {
      gridGroup
        .append('line')
        .attr('x1', x)
        .attr('y1', 0)
        .attr('x2', x)
        .attr('y2', height)
        .attr('stroke', '#0a2a20')
        .attr('stroke-width', 0.5);
    }

    for (let y = 0; y < height; y += 20) {
      gridGroup
        .append('line')
        .attr('x1', 0)
        .attr('y1', y)
        .attr('x2', width)
        .attr('y2', y)
        .attr('stroke', '#0a2a20')
        .attr('stroke-width', 0.5);
    }
  }

  private getProjection(width: number, height: number): d3.GeoProjection {
    if (this.state.view === 'global' || this.state.view === 'mena') {
      return d3
        .geoEquirectangular()
        .scale(width / (2 * Math.PI))
        .center([0, 0])
        .translate([width / 2, height / 2]);
    }

    return d3
      .geoAlbersUsa()
      .scale(width * 1.3)
      .translate([width / 2, height / 2]);
  }

  private renderGraticule(path: d3.GeoPath): void {
    const graticule = d3.geoGraticule();
    this.svg
      .append('path')
      .datum(graticule())
      .attr('class', 'graticule')
      .attr('d', path)
      .attr('fill', 'none')
      .attr('stroke', '#1a5045')
      .attr('stroke-width', 0.4);
  }

  private renderCountries(path: d3.GeoPath): void {
    if ((this.state.view === 'global' || this.state.view === 'mena') && this.worldData) {
      const countries = topojson.feature(
        this.worldData,
        this.worldData.objects.countries
      );

      const features = 'features' in countries ? countries.features : [countries];

      this.svg
        .selectAll('.country')
        .data(features)
        .enter()
        .append('path')
        .attr('class', 'country')
        .attr('d', path as unknown as string)
        .attr('fill', '#0d3028')
        .attr('stroke', '#1a8060')
        .attr('stroke-width', 0.7);
    } else if (this.state.view === 'us' && this.usData) {
      const states = topojson.feature(
        this.usData,
        this.usData.objects.states
      );

      const features = 'features' in states ? states.features : [states];

      this.svg
        .selectAll('.state')
        .data(features)
        .enter()
        .append('path')
        .attr('class', 'state')
        .attr('d', path as unknown as string)
        .attr('fill', '#0d3028')
        .attr('stroke', '#1a8060')
        .attr('stroke-width', 0.7);
    }
  }

  private renderCables(projection: d3.GeoProjection): void {
    const cableGroup = this.svg.append('g').attr('class', 'cables');

    UNDERSEA_CABLES.forEach((cable) => {
      const lineGenerator = d3
        .line<[number, number]>()
        .x((d) => projection(d)?.[0] ?? 0)
        .y((d) => projection(d)?.[1] ?? 0)
        .curve(d3.curveCardinal);

      cableGroup
        .append('path')
        .attr('class', 'cable-path')
        .attr('d', lineGenerator(cable.points))
        .append('title')
        .text(cable.name);
    });
  }

  private renderConflicts(projection: d3.GeoProjection): void {
    const conflictGroup = this.svg.append('g').attr('class', 'conflicts');

    CONFLICT_ZONES.forEach((zone) => {
      const points = zone.coords
        .map((c) => projection(c as [number, number]))
        .filter((p): p is [number, number] => p !== null);

      if (points.length > 0) {
        conflictGroup
          .append('polygon')
          .attr('class', 'conflict-zone')
          .attr('points', points.map((p) => p.join(',')).join(' '));

        const centerPos = projection(zone.center as [number, number]);
        if (centerPos) {
          conflictGroup
            .append('text')
            .attr('class', 'conflict-label')
            .attr('x', centerPos[0])
            .attr('y', centerPos[1])
            .attr('text-anchor', 'middle')
            .attr('dominant-baseline', 'middle')
            .text(zone.name);
        }
      }
    });
  }

  private renderSanctions(): void {
    if (!this.worldData) return;

    const sanctionColors: Record<string, string> = {
      severe: 'rgba(255, 0, 0, 0.35)',
      high: 'rgba(255, 100, 0, 0.25)',
      moderate: 'rgba(255, 200, 0, 0.2)',
    };

    this.svg.selectAll('.country').each(function () {
      const el = d3.select(this);
      const id = el.datum() as { id?: number };
      if (id?.id !== undefined && SANCTIONED_COUNTRIES[id.id]) {
        const level = SANCTIONED_COUNTRIES[id.id];
        if (level) {
          el.attr('fill', sanctionColors[level] || '#0a2018');
        }
      }
    });
  }

  private renderOverlays(projection: d3.GeoProjection): void {
    this.overlays.innerHTML = '';

    if (this.state.view !== 'global' && this.state.view !== 'mena') return;

    // Strategic waterways
    this.renderWaterways(projection);

    // APT groups
    this.renderAPTMarkers(projection);

    // Nuclear facilities
    if (this.state.layers.nuclear) {
      NUCLEAR_FACILITIES.forEach((facility) => {
        const pos = projection([facility.lon, facility.lat]);
        if (!pos) return;

        const div = document.createElement('div');
        div.className = `nuclear-marker ${facility.status}`;
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;
        div.title = `${facility.name} (${facility.type})`;

        const label = document.createElement('div');
        label.className = 'nuclear-label';
        label.textContent = facility.name;
        div.appendChild(label);

        this.overlays.appendChild(div);
      });
    }

    // Conflict zone click areas
    if (this.state.layers.conflicts) {
      CONFLICT_ZONES.forEach((zone) => {
        const centerPos = projection(zone.center as [number, number]);
        if (!centerPos) return;

        const clickArea = document.createElement('div');
        clickArea.className = 'conflict-click-area';
        clickArea.style.left = `${centerPos[0] - 40}px`;
        clickArea.style.top = `${centerPos[1] - 20}px`;
        clickArea.style.width = '80px';
        clickArea.style.height = '40px';
        clickArea.style.cursor = 'pointer';

        clickArea.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'conflict',
            data: zone,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        });

        this.overlays.appendChild(clickArea);
      });
    }

    // Hotspots
    if (this.state.layers.hotspots) {
      this.hotspots.forEach((spot) => {
        const pos = projection([spot.lon, spot.lat]);
        if (!pos) return;

        const div = document.createElement('div');
        div.className = 'hotspot';
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;

        const breakingBadge = spot.hasBreaking
          ? '<div class="hotspot-breaking">BREAKING</div>'
          : '';

        const subtextHtml = spot.subtext
          ? `<div class="hotspot-subtext">${spot.subtext}</div>`
          : '';

        div.innerHTML = `
          ${breakingBadge}
          <div class="hotspot-marker ${spot.level || 'low'}"></div>
          <div class="hotspot-label">${spot.name}</div>
          ${subtextHtml}
        `;

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const relatedNews = this.getRelatedNews(spot);
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'hotspot',
            data: spot,
            relatedNews,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
          this.onHotspotClick?.(spot);
        });

        this.overlays.appendChild(div);
      });
    }

    // Military bases
    if (this.state.layers.bases) {
      MILITARY_BASES.forEach((base) => {
        const pos = projection([base.lon, base.lat]);
        if (!pos) return;

        const div = document.createElement('div');
        div.className = `base-marker ${base.type}`;
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;
        div.title = base.name;
        this.overlays.appendChild(div);
      });
    }

    // Earthquakes
    if (this.state.layers.earthquakes) {
      const filteredQuakes = this.filterByTime(this.earthquakes);
      filteredQuakes.forEach((eq) => {
        const pos = projection([eq.lon, eq.lat]);
        if (!pos) return;

        const size = Math.max(8, eq.magnitude * 3);
        const div = document.createElement('div');
        div.className = 'earthquake-marker';
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;
        div.style.width = `${size}px`;
        div.style.height = `${size}px`;
        div.title = `M${eq.magnitude.toFixed(1)} - ${eq.place}`;

        const label = document.createElement('div');
        label.className = 'earthquake-label';
        label.textContent = `M${eq.magnitude.toFixed(1)}`;
        div.appendChild(label);

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'earthquake',
            data: eq,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        });

        this.overlays.appendChild(div);
      });
    }
  }

  private renderWaterways(projection: d3.GeoProjection): void {
    STRATEGIC_WATERWAYS.forEach((waterway) => {
      const pos = projection([waterway.lon, waterway.lat]);
      if (!pos) return;

      const div = document.createElement('div');
      div.className = 'waterway-label';
      div.style.left = `${pos[0]}px`;
      div.style.top = `${pos[1]}px`;
      div.innerHTML = `
        <span class="waterway-name">${waterway.name}</span>
        ${waterway.description ? `<span class="waterway-desc">${waterway.description}</span>` : ''}
      `;
      div.title = waterway.description || waterway.name;

      this.overlays.appendChild(div);
    });
  }

  private renderAPTMarkers(projection: d3.GeoProjection): void {
    APT_GROUPS.forEach((apt) => {
      const pos = projection([apt.lon, apt.lat]);
      if (!pos) return;

      const div = document.createElement('div');
      div.className = 'apt-marker';
      div.style.left = `${pos[0]}px`;
      div.style.top = `${pos[1]}px`;
      div.innerHTML = `
        <div class="apt-icon">⚠</div>
        <div class="apt-label">${apt.name}</div>
      `;
      div.title = `${apt.name} (${apt.aka}) - ${apt.sponsor}`;

      this.overlays.appendChild(div);
    });
  }

  private getRelatedNews(hotspot: Hotspot): NewsItem[] {
    return this.news.filter((item) => {
      const titleLower = item.title.toLowerCase();
      return hotspot.keywords.some((kw) => titleLower.includes(kw.toLowerCase()));
    }).slice(0, 5);
  }

  public updateHotspotActivity(news: NewsItem[]): void {
    this.news = news; // Store for related news lookup

    this.hotspots.forEach((spot) => {
      let score = 0;
      let hasBreaking = false;
      let matchedCount = 0;

      news.forEach((item) => {
        const titleLower = item.title.toLowerCase();
        const matches = spot.keywords.filter((kw) => titleLower.includes(kw.toLowerCase()));

        if (matches.length > 0) {
          matchedCount++;
          // Base score per match
          score += matches.length * 2;

          // Breaking news is critical
          if (item.isAlert) {
            score += 5;
            hasBreaking = true;
          }

          // Recent news (last 6 hours) weighted higher
          if (item.pubDate) {
            const hoursAgo = (Date.now() - item.pubDate.getTime()) / (1000 * 60 * 60);
            if (hoursAgo < 1) score += 3; // Last hour
            else if (hoursAgo < 6) score += 2; // Last 6 hours
            else if (hoursAgo < 24) score += 1; // Last day
          }
        }
      });

      spot.hasBreaking = hasBreaking;

      // Dynamic level calculation - sensitive to real activity
      // HIGH: Breaking news OR 4+ matching articles OR score >= 10
      // ELEVATED: 2+ matching articles OR score >= 4
      // LOW: Default when no significant activity
      if (hasBreaking || matchedCount >= 4 || score >= 10) {
        spot.level = 'high';
        spot.status = hasBreaking ? 'BREAKING NEWS' : 'High activity';
      } else if (matchedCount >= 2 || score >= 4) {
        spot.level = 'elevated';
        spot.status = 'Elevated activity';
      } else if (matchedCount >= 1) {
        spot.level = 'low';
        spot.status = 'Recent mentions';
      } else {
        spot.level = 'low';
        spot.status = 'Monitoring';
      }
    });

    this.render();
  }

  public setView(view: MapView): void {
    this.state.view = view;
    // Reset zoom when changing views for better UX
    this.state.zoom = view === 'mena' ? 2.5 : 1;
    this.state.pan = view === 'mena' ? { x: -180, y: 60 } : { x: 0, y: 0 };
    this.applyTransform();
    this.render();
  }

  public toggleLayer(layer: keyof MapLayers): void {
    this.state.layers[layer] = !this.state.layers[layer];

    const btn = document.querySelector(`[data-layer="${layer}"]`);
    btn?.classList.toggle('active');

    this.render();
  }

  public zoomIn(): void {
    this.state.zoom = Math.min(this.state.zoom + 0.5, 4);
    this.applyTransform();
  }

  public zoomOut(): void {
    this.state.zoom = Math.max(this.state.zoom - 0.5, 1);
    this.applyTransform();
  }

  public reset(): void {
    this.state.zoom = 1;
    this.state.pan = { x: 0, y: 0 };
    this.applyTransform();
  }

  private applyTransform(): void {
    this.wrapper.style.transform = `scale(${this.state.zoom}) translate(${this.state.pan.x}px, ${this.state.pan.y}px)`;
  }

  public onHotspotClicked(callback: (hotspot: Hotspot) => void): void {
    this.onHotspotClick = callback;
  }

  public onTimeRangeChanged(callback: (range: TimeRange) => void): void {
    this.onTimeRangeChange = callback;
  }

  public getState(): MapState {
    return { ...this.state };
  }

  public getTimeRange(): TimeRange {
    return this.state.timeRange;
  }

  public setEarthquakes(earthquakes: Earthquake[]): void {
    this.earthquakes = earthquakes;
    this.render();
  }

  public getHotspotLevels(): Record<string, string> {
    const levels: Record<string, string> = {};
    this.hotspots.forEach(spot => {
      levels[spot.name] = spot.level || 'low';
    });
    return levels;
  }

  public setHotspotLevels(levels: Record<string, string>): void {
    this.hotspots.forEach(spot => {
      if (levels[spot.name]) {
        spot.level = levels[spot.name] as 'high' | 'elevated' | 'low';
      }
    });
    this.render();
  }
}

export type { TimeRange };
