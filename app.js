// ===========================
// Configuration & State
// ===========================

const CONFIG = {
    USER_ACCESS_CODE: 'CRYPTO2024',
    ADMIN_ACCESS_CODE: 'ADMIN2024',
    PRICE_UPDATE_INTERVAL: 2000, // 2 seconds
    NOTIFICATION_DURATION: 5000
};

const STATE = {
    isAdmin: false,
    signals: [],
    notifications: [],
    currentFilter: 'all',
    priceMonitor: null,
    websockets: new Map(), // Track WebSocket connections per symbol
    priceCache: new Map()  // Cache latest prices
};

// ===========================
// Initialization
// ===========================

document.addEventListener('DOMContentLoaded', () => {
    initializeApp();
    setupEventListeners();
    requestNotificationPermission();
});

function initializeApp() {
    // Load signals from localStorage
    const savedSignals = localStorage.getItem('cryptoSignals');
    if (savedSignals) {
        STATE.signals = JSON.parse(savedSignals);
    }

    // Check if user is already authenticated
    const isAuthenticated = sessionStorage.getItem('authenticated');
    const isAdmin = sessionStorage.getItem('isAdmin') === 'true';

    if (isAuthenticated) {
        STATE.isAdmin = isAdmin;
        showApp();
    }
}

// ===========================
// Event Listeners
// ===========================

function setupEventListeners() {
    // Access form
    document.getElementById('accessForm').addEventListener('submit', handleAccessSubmit);
    document.getElementById('adminAccessBtn').addEventListener('click', handleAdminAccess);

    // Logout
    document.getElementById('logoutBtn').addEventListener('click', handleLogout);

    // Create signal
    document.getElementById('createSignalBtn')?.addEventListener('click', showCreateSignalModal);
    document.getElementById('closeSignalModal').addEventListener('click', hideCreateSignalModal);
    document.getElementById('cancelSignalBtn').addEventListener('click', hideCreateSignalModal);
    document.getElementById('signalForm').addEventListener('submit', handleCreateSignal);

    // Filter tabs
    document.querySelectorAll('.filter-tab').forEach(tab => {
        tab.addEventListener('click', (e) => handleFilterChange(e.target.dataset.filter));
    });

    // Notification bell
    document.getElementById('notificationBell').addEventListener('click', showNotifications);
}

// ===========================
// Authentication
// ===========================

function handleAccessSubmit(e) {
    e.preventDefault();
    const code = document.getElementById('accessCode').value.trim();

    if (code === CONFIG.USER_ACCESS_CODE) {
        sessionStorage.setItem('authenticated', 'true');
        sessionStorage.setItem('isAdmin', 'false');
        STATE.isAdmin = false;
        showApp();
    } else if (code === CONFIG.ADMIN_ACCESS_CODE) {
        sessionStorage.setItem('authenticated', 'true');
        sessionStorage.setItem('isAdmin', 'true');
        STATE.isAdmin = true;
        showApp();
    } else {
        showToast('Access Denied', 'Invalid access code. Please try again.');
        document.getElementById('accessCode').value = '';
    }
}

function handleAdminAccess() {
    const code = prompt('Enter admin access code:');
    if (code === CONFIG.ADMIN_ACCESS_CODE) {
        sessionStorage.setItem('authenticated', 'true');
        sessionStorage.setItem('isAdmin', 'true');
        STATE.isAdmin = true;
        showApp();
    } else if (code) {
        showToast('Access Denied', 'Invalid admin code.');
    }
}

function handleLogout() {
    sessionStorage.removeItem('authenticated');
    sessionStorage.removeItem('isAdmin');
    STATE.isAdmin = false;
    stopPriceMonitoring();

    document.getElementById('accessModal').classList.add('active');
    document.getElementById('app').classList.remove('active');
    document.getElementById('accessCode').value = '';
}

function showApp() {
    document.getElementById('accessModal').classList.remove('active');
    document.getElementById('app').classList.add('active');

    if (STATE.isAdmin) {
        document.getElementById('userPanel').style.display = 'none';
        document.getElementById('adminPanel').style.display = 'block';
        renderAdminSignals();
        updateAdminStats();
    } else {
        document.getElementById('userPanel').style.display = 'block';
        document.getElementById('adminPanel').style.display = 'none';
        renderUserSignals();
        updateUserStats();
    }

    startPriceMonitoring();
}

// ===========================
// Signal Management
// ===========================

async function handleCreateSignal(e) {
    e.preventDefault();

    const symbol = document.getElementById('signalSymbol').value.toUpperCase();

    // Fetch initial price from Binance
    const initialPrice = await fetchInitialPrice(symbol);

    const signal = {
        id: Date.now().toString(),
        symbol: symbol,
        type: document.getElementById('signalType').value,
        entry: parseFloat(document.getElementById('signalEntry').value),
        trigger: parseFloat(document.getElementById('signalTrigger').value) || null,
        stopLoss: parseFloat(document.getElementById('signalStopLoss').value),
        takeProfit: parseFloat(document.getElementById('signalTakeProfit').value),
        notes: document.getElementById('signalNotes').value,
        status: 'active',
        createdAt: new Date().toISOString(),
        currentPrice: initialPrice || null
    };

    STATE.signals.unshift(signal);
    saveSignals();

    // Connect WebSocket for this symbol
    connectWebSocket(symbol);

    hideCreateSignalModal();
    renderAdminSignals();
    updateAdminStats();

    showToast('Signal Created', `${signal.symbol} ${signal.type} signal created successfully.`);

    // Reset form
    document.getElementById('signalForm').reset();
}

function deleteSignal(signalId) {
    if (confirm('Are you sure you want to delete this signal?')) {
        STATE.signals = STATE.signals.filter(s => s.id !== signalId);
        saveSignals();
        renderAdminSignals();
        updateAdminStats();
        showToast('Signal Deleted', 'The signal has been removed.');
    }
}

function saveSignals() {
    localStorage.setItem('cryptoSignals', JSON.stringify(STATE.signals));
}

// ===========================
// Real-time Price Monitoring - Binance WebSocket
// ===========================

function startPriceMonitoring() {
    if (STATE.priceMonitor) return;

    // Get unique symbols from active signals
    const activeSymbols = new Set();
    STATE.signals.forEach(signal => {
        if (signal.status === 'active' || signal.status === 'triggered') {
            activeSymbols.add(signal.symbol);
        }
    });

    // Connect WebSocket for each unique symbol
    activeSymbols.forEach(symbol => {
        connectWebSocket(symbol);
    });

    // Check signal conditions every 2 seconds
    STATE.priceMonitor = setInterval(() => {
        STATE.signals.forEach(signal => {
            if (signal.status === 'active' || signal.status === 'triggered') {
                checkSignalConditions(signal);
            }
        });

        if (STATE.isAdmin) {
            renderAdminSignals();
        } else {
            renderUserSignals();
        }
    }, CONFIG.PRICE_UPDATE_INTERVAL);
}

function stopPriceMonitoring() {
    // Close all WebSocket connections
    STATE.websockets.forEach((ws, symbol) => {
        ws.close();
    });
    STATE.websockets.clear();
    STATE.priceCache.clear();

    if (STATE.priceMonitor) {
        clearInterval(STATE.priceMonitor);
        STATE.priceMonitor = null;
    }
}

function connectWebSocket(symbol) {
    // Don't reconnect if already connected
    if (STATE.websockets.has(symbol)) return;

    // Convert symbol to Binance format (e.g., BTCUSDT -> btcusdt)
    const binanceSymbol = symbol.toLowerCase();

    // Binance WebSocket URL for individual symbol ticker
    const wsUrl = `wss://stream.binance.com:9443/ws/${binanceSymbol}@ticker`;

    try {
        const ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            console.log(`✅ WebSocket connected for ${symbol}`);
            showToast('Connected', `Real-time feed active for ${symbol}`);
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                // Binance ticker data includes 'c' for current price
                const price = parseFloat(data.c);

                if (price && !isNaN(price)) {
                    STATE.priceCache.set(symbol, price);

                    // Update all signals with this symbol
                    STATE.signals.forEach(signal => {
                        if (signal.symbol === symbol) {
                            signal.currentPrice = price;
                        }
                    });
                }
            } catch (error) {
                console.error(`Error parsing WebSocket data for ${symbol}:`, error);
            }
        };

        ws.onerror = (error) => {
            console.error(`WebSocket error for ${symbol}:`, error);
            showToast('Connection Error', `Failed to connect to ${symbol} feed. Retrying...`);
        };

        ws.onclose = () => {
            console.log(`WebSocket closed for ${symbol}`);
            STATE.websockets.delete(symbol);

            // Reconnect if signal is still active
            setTimeout(() => {
                const hasActiveSignal = STATE.signals.some(s =>
                    s.symbol === symbol && (s.status === 'active' || s.status === 'triggered')
                );
                if (hasActiveSignal) {
                    connectWebSocket(symbol);
                }
            }, 5000); // Retry after 5 seconds
        };

        STATE.websockets.set(symbol, ws);

    } catch (error) {
        console.error(`Failed to create WebSocket for ${symbol}:`, error);
        showToast('Connection Failed', `Unable to connect to ${symbol}`);
    }
}

function checkSignalConditions(signal) {
    // Get current price from cache or signal
    const currentPrice = STATE.priceCache.get(signal.symbol) || signal.currentPrice;

    if (!currentPrice) {
        // If no price available, initialize with entry price
        signal.currentPrice = signal.entry;
        return;
    }

    signal.currentPrice = currentPrice;

    // Check trigger
    if (signal.status === 'active' && signal.trigger) {
        if (signal.type === 'LONG' && signal.currentPrice >= signal.trigger) {
            signal.status = 'triggered';
            sendNotification(signal, 'Trigger Hit 🎯', `${signal.symbol} reached trigger price: $${signal.currentPrice.toFixed(2)}`);
            saveSignals();
        } else if (signal.type === 'SHORT' && signal.currentPrice <= signal.trigger) {
            signal.status = 'triggered';
            sendNotification(signal, 'Trigger Hit 🎯', `${signal.symbol} reached trigger price: $${signal.currentPrice.toFixed(2)}`);
            saveSignals();
        }
    }

    // Check stop loss
    if (signal.type === 'LONG' && signal.currentPrice <= signal.stopLoss) {
        signal.status = 'stopped';
        sendNotification(signal, 'Stop Loss Hit 🛑', `${signal.symbol} hit stop loss at $${signal.currentPrice.toFixed(2)}`);
        saveSignals();
    } else if (signal.type === 'SHORT' && signal.currentPrice >= signal.stopLoss) {
        signal.status = 'stopped';
        sendNotification(signal, 'Stop Loss Hit 🛑', `${signal.symbol} hit stop loss at $${signal.currentPrice.toFixed(2)}`);
        saveSignals();
    }

    // Check take profit
    if (signal.type === 'LONG' && signal.currentPrice >= signal.takeProfit) {
        signal.status = 'completed';
        sendNotification(signal, 'Take Profit Hit 🎉', `${signal.symbol} reached take profit at $${signal.currentPrice.toFixed(2)}!`);
        saveSignals();
    } else if (signal.type === 'SHORT' && signal.currentPrice <= signal.takeProfit) {
        signal.status = 'completed';
        sendNotification(signal, 'Take Profit Hit 🎉', `${signal.symbol} reached take profit at $${signal.currentPrice.toFixed(2)}!`);
        saveSignals();
    }
}

// Fetch initial price from Binance REST API
async function fetchInitialPrice(symbol) {
    try {
        const binanceSymbol = symbol.toUpperCase();
        const response = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${binanceSymbol}`);
        const data = await response.json();

        if (data.price) {
            const price = parseFloat(data.price);
            STATE.priceCache.set(symbol, price);
            return price;
        }
    } catch (error) {
        console.error(`Failed to fetch initial price for ${symbol}:`, error);
    }
    return null;
}

// ===========================
// Notifications
// ===========================

function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
}

function sendNotification(signal, title, message) {
    // In-app notification
    showToast(title, message);

    // Browser notification
    if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(title, {
            body: message,
            icon: '/favicon.ico',
            badge: '/favicon.ico'
        });
    }

    // Update notification count
    STATE.notifications.push({ signal, title, message, timestamp: new Date() });
    updateNotificationBadge();
}

function updateNotificationBadge() {
    const badge = document.querySelector('.notification-badge');
    const count = STATE.notifications.length;
    badge.textContent = count > 99 ? '99+' : count;
}

function showNotifications() {
    if (STATE.notifications.length === 0) {
        showToast('No Notifications', 'You have no new notifications.');
        return;
    }

    const messages = STATE.notifications.slice(-5).reverse().map(n =>
        `${n.title}: ${n.message}`
    ).join('\n');

    alert('Recent Notifications:\n\n' + messages);

    STATE.notifications = [];
    updateNotificationBadge();
}

function showToast(title, message) {
    const toast = document.getElementById('notificationToast');
    const titleEl = toast.querySelector('.toast-title');
    const messageEl = toast.querySelector('.toast-message');

    titleEl.textContent = title;
    messageEl.textContent = message;

    toast.classList.add('show');

    setTimeout(() => {
        toast.classList.remove('show');
    }, CONFIG.NOTIFICATION_DURATION);
}

// ===========================
// Rendering
// ===========================

function renderUserSignals() {
    const container = document.getElementById('signalsList');
    const filteredSignals = filterSignals();

    if (filteredSignals.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
                    <path d="M12 6V12L16 14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                </svg>
                <p>No signals available</p>
                <span>Signals will appear here when admin creates them</span>
            </div>
        `;
        return;
    }

    container.innerHTML = filteredSignals.map(signal => createSignalCard(signal, false)).join('');
    updateUserStats();
}

function renderAdminSignals() {
    const container = document.getElementById('adminSignalsList');

    if (STATE.signals.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M12 5V19M5 12H19" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                <p>No signals created yet</p>
                <span>Click "Create Signal" to add your first trading signal</span>
            </div>
        `;
        return;
    }

    container.innerHTML = STATE.signals.map(signal => createSignalCard(signal, true)).join('');
    updateAdminStats();
}

function createSignalCard(signal, isAdmin) {
    const priceDisplay = signal.currentPrice ? signal.currentPrice.toFixed(8) : signal.entry.toFixed(8);
    const pnl = calculatePnL(signal);

    return `
        <div class="signal-card">
            <div class="signal-header">
                <div class="signal-title">
                    <span class="signal-symbol">${signal.symbol}</span>
                    <span class="signal-type ${signal.type.toLowerCase()}">${signal.type}</span>
                </div>
                <span class="signal-status ${signal.status}">${signal.status.toUpperCase()}</span>
            </div>
            
            <div class="signal-details">
                <div class="detail-item">
                    <span class="detail-label">Current Price</span>
                    <span class="detail-value">${priceDisplay}</span>
                </div>
                <div class="detail-item">
                    <span class="detail-label">Entry</span>
                    <span class="detail-value">${signal.entry.toFixed(8)}</span>
                </div>
                ${signal.trigger ? `
                <div class="detail-item">
                    <span class="detail-label">Trigger</span>
                    <span class="detail-value">${signal.trigger.toFixed(8)}</span>
                </div>
                ` : ''}
                <div class="detail-item">
                    <span class="detail-label">Stop Loss</span>
                    <span class="detail-value">${signal.stopLoss.toFixed(8)}</span>
                </div>
                <div class="detail-item">
                    <span class="detail-label">Take Profit</span>
                    <span class="detail-value">${signal.takeProfit.toFixed(8)}</span>
                </div>
                <div class="detail-item">
                    <span class="detail-label">P&L</span>
                    <span class="detail-value" style="color: ${pnl >= 0 ? 'var(--color-success)' : 'var(--color-danger)'}">
                        ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%
                    </span>
                </div>
            </div>
            
            ${signal.notes ? `
            <div class="signal-notes">
                <strong>Notes:</strong> ${signal.notes}
            </div>
            ` : ''}
            
            ${isAdmin ? `
            <div class="signal-actions">
                <button class="btn btn-small btn-danger" onclick="deleteSignal('${signal.id}')">
                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M3 6H5H21M8 6V4C8 3.46957 8.21071 2.96086 8.58579 2.58579C8.96086 2.21071 9.46957 2 10 2H14C14.5304 2 15.0391 2.21071 15.4142 2.58579C15.7893 2.96086 16 3.46957 16 4V6M19 6V20C19 20.5304 18.7893 21.0391 18.4142 21.4142C18.0391 21.7893 17.5304 22 17 22H7C6.46957 22 5.96086 21.7893 5.58579 21.4142C5.21071 21.0391 5 20.5304 5 20V6H19Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                    <span>Delete</span>
                </button>
            </div>
            ` : ''}
        </div>
    `;
}

function calculatePnL(signal) {
    if (!signal.currentPrice) return 0;

    if (signal.type === 'LONG') {
        return ((signal.currentPrice - signal.entry) / signal.entry) * 100;
    } else {
        return ((signal.entry - signal.currentPrice) / signal.entry) * 100;
    }
}

function filterSignals() {
    if (STATE.currentFilter === 'all') {
        return STATE.signals;
    }
    return STATE.signals.filter(s => s.status === STATE.currentFilter);
}

function handleFilterChange(filter) {
    STATE.currentFilter = filter;

    document.querySelectorAll('.filter-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.filter === filter);
    });

    renderUserSignals();
}

// ===========================
// Stats Updates
// ===========================

function updateUserStats() {
    const activeSignals = STATE.signals.filter(s => s.status === 'active' || s.status === 'triggered');
    const pendingTriggers = STATE.signals.filter(s => s.status === 'active' && s.trigger);

    document.getElementById('activeSignalsCount').textContent = activeSignals.length;
    document.getElementById('pendingTriggersCount').textContent = pendingTriggers.length;
    document.getElementById('totalSignalsCount').textContent = STATE.signals.length;
}

function updateAdminStats() {
    const completedSignals = STATE.signals.filter(s => s.status === 'completed');
    const totalClosed = STATE.signals.filter(s => s.status === 'completed' || s.status === 'stopped');
    const successRate = totalClosed.length > 0
        ? ((completedSignals.length / totalClosed.length) * 100).toFixed(0)
        : 0;

    document.getElementById('monitoringStatus').textContent = STATE.priceMonitor ? 'Active' : 'Stopped';
    document.getElementById('successRate').textContent = successRate + '%';
    document.getElementById('activeUsers').textContent = '1';
}

// ===========================
// Modal Controls
// ===========================

function showCreateSignalModal() {
    document.getElementById('createSignalModal').classList.add('active');
}

function hideCreateSignalModal() {
    document.getElementById('createSignalModal').classList.remove('active');
}

// Close modals on backdrop click
document.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-backdrop')) {
        e.target.parentElement.classList.remove('active');
    }
});
