import type { CorrelationSignal } from '@/services/correlation';

export class SignalModal {
  private element: HTMLElement;
  private currentSignals: CorrelationSignal[] = [];
  private audioEnabled = true;
  private audio: HTMLAudioElement | null = null;
  private signalBadge: HTMLElement | null = null;
  private pendingCount = 0;

  constructor() {
    this.element = document.createElement('div');
    this.element.className = 'signal-modal-overlay';
    this.element.innerHTML = `
      <div class="signal-modal">
        <div class="signal-modal-header">
          <span class="signal-modal-title">⚡ SIGNAL DETECTED</span>
          <button class="signal-modal-close">×</button>
        </div>
        <div class="signal-modal-content"></div>
        <div class="signal-modal-footer">
          <label class="signal-audio-toggle">
            <input type="checkbox" checked>
            <span>Sound alerts</span>
          </label>
          <button class="signal-dismiss-btn">Dismiss</button>
        </div>
      </div>
    `;

    document.body.appendChild(this.element);
    this.setupEventListeners();
    this.initAudio();
    this.createSignalBadge();
  }

  private createSignalBadge(): void {
    this.signalBadge = document.createElement('button');
    this.signalBadge.className = 'signal-badge hidden';
    this.signalBadge.innerHTML = '<span class="signal-badge-icon">⚡</span><span class="signal-badge-count">0</span>';
    this.signalBadge.addEventListener('click', () => {
      if (this.currentSignals.length > 0) {
        this.renderSignals();
        this.element.classList.add('active');
      }
    });

    const headerRight = document.querySelector('.header-right');
    if (headerRight) {
      headerRight.insertBefore(this.signalBadge, headerRight.firstChild);
    }
  }

  private initAudio(): void {
    this.audio = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2teleQYjfKapmWswEjCJvuPQfSoXZZ+3qqBJESSP0unGaxMJVYiytrFeLhR6p8znrFUXRW+bs7V3Qx1hn8Xjp1cYPnegprhkMCFmoLi1k0sZTYGlqqlUIA==');
    this.audio.volume = 0.3;
  }

  private setupEventListeners(): void {
    this.element.querySelector('.signal-modal-close')?.addEventListener('click', () => {
      this.hide();
    });

    this.element.querySelector('.signal-dismiss-btn')?.addEventListener('click', () => {
      this.hide();
    });

    this.element.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('signal-modal-overlay')) {
        this.hide();
      }
    });

    const checkbox = this.element.querySelector('input[type="checkbox"]') as HTMLInputElement;
    checkbox?.addEventListener('change', () => {
      this.audioEnabled = checkbox.checked;
    });
  }

  public show(signals: CorrelationSignal[]): void {
    if (signals.length === 0) return;

    this.currentSignals = signals;
    this.pendingCount = signals.length;
    this.updateBadge();
    this.renderSignals();
    this.element.classList.add('active');

    if (this.audioEnabled && this.audio) {
      this.audio.currentTime = 0;
      this.audio.play().catch(() => {});
    }

    // Flash header
    const header = document.querySelector('.header');
    header?.classList.add('signal-flash');
    setTimeout(() => header?.classList.remove('signal-flash'), 2000);

    // Pulse status indicator
    const statusDot = document.querySelector('.status-dot');
    statusDot?.classList.add('signal-pulse');
    setTimeout(() => statusDot?.classList.remove('signal-pulse'), 5000);
  }

  private updateBadge(): void {
    if (!this.signalBadge) return;

    const countEl = this.signalBadge.querySelector('.signal-badge-count');
    if (countEl) countEl.textContent = String(this.pendingCount);

    if (this.pendingCount > 0) {
      this.signalBadge.classList.remove('hidden');
      this.signalBadge.classList.add('active');
    } else {
      this.signalBadge.classList.add('hidden');
      this.signalBadge.classList.remove('active');
    }
  }

  public hide(): void {
    this.element.classList.remove('active');
    this.pendingCount = 0;
    this.updateBadge();
  }

  private renderSignals(): void {
    const content = this.element.querySelector('.signal-modal-content')!;

    const signalTypeLabels: Record<string, string> = {
      'prediction_leads_news': '🔮 Prediction Leading',
      'news_leads_markets': '📰 News Leading',
      'silent_divergence': '📊 Silent Divergence',
      'velocity_spike': '🔥 Velocity Spike',
    };

    const html = this.currentSignals.map(signal => `
      <div class="signal-item ${signal.type}">
        <div class="signal-type">${signalTypeLabels[signal.type] || signal.type}</div>
        <div class="signal-title">${signal.title}</div>
        <div class="signal-description">${signal.description}</div>
        <div class="signal-meta">
          <span class="signal-confidence">Confidence: ${Math.round(signal.confidence * 100)}%</span>
          <span class="signal-time">${this.formatTime(signal.timestamp)}</span>
        </div>
        ${signal.data.relatedTopics?.length ? `
          <div class="signal-topics">
            ${signal.data.relatedTopics.map(t => `<span class="signal-topic">${t}</span>`).join('')}
          </div>
        ` : ''}
      </div>
    `).join('');

    content.innerHTML = html;
  }

  private formatTime(date: Date): string {
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  }

  public getElement(): HTMLElement {
    return this.element;
  }
}
