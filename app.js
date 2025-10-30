/*
 * Waze Korrelations-Logger - v14 "Anti-Schlaf-Hack"
 * =================================================
 *
 * ANALYSE v13-LOG:
 * 1. ERFOLG: "Permission-Freeze" (v11) ist GELÖST.
 * 2. ERFOLG: "Jolt Detection" (v8) & Flugschreiber
 * funktionieren im Feldversuch PERFEKT.
 * 3. FEHLER 1 (SCHWARZES LOCH v3): Der "Netzwerk-Spion" (v10)
 * ist BLIND. Er erkennt die AA-WiFi-Direct-Verbindung nicht.
 * Er wird daher in v14 wieder ENTFERNT.
 * 4. FEHLER 2 (SCHWARZES LOCH v4 - SHOW-STOPPER):
 * Der Log hat eine 3-Minuten-Lücke. Android OS (Doze)
 * friert unsere Hintergrund-App ein.
 *
 * PLAN v14:
 * 1. Wir implementieren einen "Anti-Schlaf-Hack".
 * 2. Beim START wird ein stilles Audio (Gain=0) über die
 * Web Audio API abgespielt, um dem OS vorzutäuschen,
 * wir seien eine "Media App", die nicht einfrieren darf.
 * 3. Dies ist Prio 1. Die Erkennung des AA-Handshakes
 * wird auf v15 verschoben, bis der Logger wach bleibt.
 *
 * Gebaut von deinem Sparingpartner.
 */
"use strict";

document.addEventListener("DOMContentLoaded", () => {
    
    // --- DOM-Elemente ---
    const statusEl = document.getElementById('status');
    const logAreaEl = document.getElementById('logArea');
    const permissionBtn = document.getElementById('permissionBtn');
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    const crashBtn = document.getElementById('crashBtn');
    const downloadBtn = document.getElementById('downloadBtn');
    const fallbackToggle = document.getElementById('fallbackToggle');
    // v14: Dashboard (aus v14-Entwurf) wieder entfernt. Fokus auf Stabilität.
    
    // --- Logger-Status ---
    let isLogging = false;
    let logEntries = [];
    let geoWatchId = null;
    let permissionsState = { gps: false, motion: false, orientation: false, network: false };

    // --- v14: Anti-Schlaf-Audio-Kontext ---
    let antiSleepContext = null;
    let antiSleepOscillator = null;

    // --- v6: DEBUG Heartbeat Flags ---
    let motionSensorHasFired = false;
    let orientationSensorHasFired = false;

    // --- v5: Flugschreiber & Jolt Detection ---
    let flightRecorderBuffer = [];
    const FLIGHT_RECORDER_DURATION_MS = 2500;
    const JOLT_THRESHOLD_MS2 = 25.0; 
    const JOLT_COOLDOWN_MS = 5000; 
    let lastJoltTime = 0;

    // --- Hilfsfunktion: Delay ---
    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // --- Universal-Funktion zum Loggen (ins Haupt-Log) ---
    function getTimestamp() {
        return new Date().toISOString();
    }
    const logDebug = (window.logDebug || console.log);

    function addLogEntry(message, level = 'info') {
        const logString = `${getTimestamp()} | ${message}`;
        logEntries.push(logString);
        if (level === 'error') console.error(logString);
        else if (level === 'warn') console.warn(logString);
        else console.log(logString);
        updateLogDisplay();
    }

    function updateLogDisplay() {
         if (logAreaEl) {
            logAreaEl.value = logEntries.slice(-100).join('\n');
            logAreaEl.scrollTop = logAreaEl.scrollHeight;
         }
    }

    // --- v5: Flugschreiber-Funktionen ---
    function pushToFlightRecorder(timestamp, type, dataString) {
        flightRecorderBuffer.push({ timestamp, type, dataString });
        const cutoffTime = timestamp - FLIGHT_RECORDER_DURATION_MS;
        while (flightRecorderBuffer.length > 0 && flightRecorderBuffer[0].timestamp < cutoffTime) {
            flightRecorderBuffer.shift();
        }
    }
    function dumpFlightRecorder(markerTime, reason) {
        addLogEntry(`\n--- !!! ${reason} (${markerTime}) !!! ---`, 'warn');
        addLogEntry(`--- START FLUGSCHREIBER-DUMP (Letzte ${FLIGHT_RECORDER_DURATION_MS}ms) ---`, 'warn');
        if (flightRecorderBuffer.length === 0) { addLogEntry(" (Flugschreiber-Puffer ist leer) ", 'warn'); }
        else {
            [...flightRecorderBuffer].forEach(entry => {
                const timeDiff = new Date(markerTime).getTime() - entry.timestamp;
                const timeAgo = (timeDiff / 1000).toFixed(3);
                addLogEntry(`[T-${timeAgo}s] | ${entry.type} | ${entry.dataString}`, 'info');
            });
        }
        addLogEntry("--- ENDE FLUGSCHREIBER-DUMP ---\n", 'warn');
    }

    // ===================================
    // --- SENSOR-HANDLER (v14) ---
    // ===================================

    // 1. GPS-Erfolg
    function logPosition(position) { 
        const coords = position.coords;
        const speedKmh = (coords.speed ? coords.speed * 3.6 : 0).toFixed(1);
        const logData = [ `GPS-OK | Acc: ${coords.accuracy.toFixed(1)}m`, `Speed: ${speedKmh} km/h` ];
        addLogEntry(logData.join(' | '));
        statusEl.textContent = `LOGGING... (GPS: ${coords.accuracy.toFixed(1)}m)`; // Status-Update
     }

    // 2. GPS-Fehler
    function logError(error) { 
        let message = '';
        switch(error.code) {
            case error.PERMISSION_DENIED: message = "GPS-Zugriff verweigert"; break;
            case error.POSITION_UNAVAILABLE: message = "Position nicht verfügbar (Kein Signal)"; break;
            case error.TIMEOUT: message = "GPS-Timeout"; break;
            default: message = `Unbekannter GPS-Fehler (Code: ${error.code})`;
        }
        addLogEntry(`GPS-FEHLER: ${message}`, 'error');
        statusEl.textContent = "Fehler: GPS-Problem!";
     }
    
    // 3. Bewegungssensor
    function logDeviceMotion(event) {
        const now = Date.now();
        const acc = event.accelerationIncludingGravity;
        if (!motionSensorHasFired) {
            motionSensorHasFired = true;
            if (!acc || acc.x === null) { addLogEntry("DEBUG: 'devicemotion' feuert, ABER DATEN SIND NULL.", 'warn'); }
            else { addLogEntry("DEBUG: 'devicemotion' feuert erfolgreich mit Daten.", 'info'); }
        }
        if (!acc || acc.x === null) return; 
        const dataString = `X: ${acc.x.toFixed(2)} | Y: ${acc.y.toFixed(2)} | Z: ${acc.z.toFixed(2)}`;
        pushToFlightRecorder(now, 'MOTION', dataString);
        const gForce = Math.sqrt(acc.x**2 + acc.y**2 + acc.z**2);
        if (gForce > JOLT_THRESHOLD_MS2 && (now - lastJoltTime > JOLT_COOLDOWN_MS)) {
            lastJoltTime = now;
            const reason = `HARTER STOSS ERKANNT (G-Force: ${gForce.toFixed(1)})`;
            dumpFlightRecorder(getTimestamp(), reason);
        }
    }

    // 4. Orientierungssensor
    function logDeviceOrientation(event) {
        const now = Date.now();
        if (!orientationSensorHasFired) {
            orientationSensorHasFired = true;
            if (event.alpha === null) { addLogEntry("DEBUG: 'deviceorientation' feuert, ABER DATEN SIND NULL.", 'warn'); }
            else { addLogEntry("DEBUG: 'deviceorientation' feuert erfolgreich mit Daten.", 'info'); }
        }
        if (event.alpha === null) return;
        const dataString = `Alpha(Z): ${event.alpha.toFixed(1)} | Beta(X): ${event.beta.toFixed(1)} | Gamma(Y): ${event.gamma.toFixed(1)}`;
        pushToFlightRecorder(now, 'ORIENTATION', dataString);
    }
    
    // 5. v14: Anti-Schlaf-Hack (Stilles Audio)
    function startAntiSleepAudio() {
        try {
            if (antiSleepContext) { antiSleepContext.close(); } // Alten Kontext schließen, falls vorhanden
            
            // 1. Audio-Kontext erstellen
            antiSleepContext = new (window.AudioContext || window.webkitAudioContext)();
            
            // 2. Oszillator (Ton-Generator) erstellen
            antiSleepOscillator = antiSleepContext.createOscillator();
            antiSleepOscillator.type = 'sine'; // Einfacher Sinus-Ton
            antiSleepOscillator.frequency.setValueAtTime(1, antiSleepContext.currentTime); // 1 Hz (unhörbar)
            
            // 3. Gain-Node (Lautstärke) erstellen
            const gainNode = antiSleepContext.createGain();
            gainNode.gain.setValueAtTime(0.0, antiSleepContext.currentTime); // STUMM!
            
            // 4. Verbinden: Oszillator -> Lautstärke (stumm) -> Lautsprecher
            antiSleepOscillator.connect(gainNode);
            gainNode.connect(antiSleepContext.destination);
            
            // 5. Starten
            antiSleepOscillator.start();
            
            addLogEntry("DEBUG: 'Anti-Schlaf-Hack' (Stilles Audio) gestartet.", 'info');
            
        } catch (e) {
            addLogEntry(`FEHLER: 'Anti-Schlaf-Hack' konnte nicht gestartet werden: ${e.message}`, 'error');
        }
    }
    
    function stopAntiSleepAudio() {
         try {
            if (antiSleepOscillator) {
                antiSleepOscillator.stop();
                antiSleepOscillator = null;
            }
            if (antiSleepContext) {
                antiSleepContext.close();
                antiSleepContext = null;
            }
            addLogEntry("DEBUG: 'Anti-Schlaf-Hack' (Stilles Audio) gestoppt.", 'info');
         } catch (e) {
             addLogEntry(`FEHLER: 'Anti-Schlaf-Hack' konnte nicht gestoppt werden: ${e.message}`, 'error');
         }
    }


    // ===================================
    // --- STEUERUNGS-FUNKTIONEN (v14) ---
    // ===================================

    // Phase A: Pre-Flight Check (Identisch zu v13, aber ohne Netzwerk-Check)
    async function requestAllPermissions() {
        addLogEntry("Phase A: Fordere Berechtigungen an (v14)...");
        statusEl.textContent = "Berechtigungen anfordern...";
        const useFallback = fallbackToggle.checked;
        if (useFallback) { addLogEntry("DEBUG v14: 'Alte API erzwingen' ist AKTIV. Überspringe 'requestPermission'.", 'warn'); }

        // --- GPS ---
        addLogEntry("DEBUG v14: Fordere GPS an...");
        try {
            if (!navigator.geolocation) throw new Error("Geolocation wird nicht unterstützt.");
            await new Promise((resolve, reject) => { navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 10000 }); });
            permissionsState.gps = true; addLogEntry("DEBUG v14: BERECHTIGUNG: GPS erteilt.");
        } catch (err) { addLogEntry(`BERECHTIGUNG: GPS-Fehler (${err.message})`, 'error'); permissionsState.gps = false; }
        addLogEntry("DEBUG v14: GPS-Anfrage abgeschlossen.");

        // --- Netzwerk (v14: Entfernt. War nutzlos.) ---
        permissionsState.network = false;

        // --- Bewegung ---
        addLogEntry("DEBUG v14: Prüfe Bewegungssensor...");
        if (useFallback) {
            permissionsState.motion = true; addLogEntry("DEBUG v14: BERECHTIGUNG: Bewegungssensor (Fallback erzwungen) OK.");
        } else if (typeof(DeviceMotionEvent.requestPermission) === 'function') {
            addLogEntry("DEBUG v14: 'requestPermission' Motion-API erkannt, fordere an...");
            try {
                const state = await DeviceMotionEvent.requestPermission();
                permissionsState.motion = (state === 'granted');
                addLogEntry(`DEBUG v14: BERECHTIGUNG: Bewegungssensor-Status: '${state}'`, (state === 'granted' ? 'info' : 'warn'));
            } catch (err) { addLogEntry(`DEBUG v14: BERECHTIGUNG: Bewegungssensor-Fehler: ${err.message}`, 'error'); permissionsState.motion = false; }
        } else if ('DeviceMotionEvent' in window) {
             permissionsState.motion = true; addLogEntry("DEBUG v14: BERECHTIGUNG: Bewegungssensor (Implizit/Alt) OK.");
        } else { addLogEntry("BERECHTIGUNG: Bewegungssensor wird nicht unterstützt!", 'error'); permissionsState.motion = false; }
        addLogEntry("DEBUG v14: Bewegungssensor-Check abgeschlossen.");

        // --- Orientierung ---
        addLogEntry("DEBUG v14: Füge kleine Pause ein (500ms)..."); await delay(500); 
        addLogEntry("DEBUG v14: Prüfe Orientierungssensor...");
        if (useFallback) {
             permissionsState.orientation = true; addLogEntry("DEBUG v14: BERECHTIGUNG: Orientierungssensor (Fallback erzwungen) OK.");
        } else if (typeof(DeviceOrientationEvent.requestPermission) === 'function') {
             addLogEntry("DEBUG v14: 'requestPermission' Orientation-API erkannt, fordere an...");
            try {
                const state = await DeviceOrientationEvent.requestPermission();
                permissionsState.orientation = (state === 'granted');
                addLogEntry(`DEBUG v14: BERECHTIGUNG: Orientierungssensor-Status: '${state}'`, (state === 'granted' ? 'info' : 'warn'));
            } catch (err) { addLogEntry(`DEBUG v14: BERECHTIGUNG: Orientierungssensor-Fehler: ${err.message}`, 'error'); permissionsState.orientation = false; }
        } else if ('DeviceOrientationEvent' in window) {
            permissionsState.orientation = true; addLogEntry("DEBUG v14: BERECHTIGUNG: Orientierungssensor (Implizit/Alt) OK.");
        } else { addLogEntry("BERECHTIGUNG: Orientierungssensor wird nicht unterstützt!", 'error'); permissionsState.orientation = false; }
        addLogEntry("DEBUG v14: Orientierungssensor-Check abgeschlossen.");
        
        addLogEntry("Phase A: Pre-Flight Check beendet.");
        return permissionsState.gps; 
    }

    // Phase B: Startet alle Logger (v14)
    function startAllLoggers() {
        addLogEntry("Phase B: Starte alle Logger (v14)...");
        statusEl.textContent = "LOGGING... (Starte Sensoren)";

        // 1. v14: Anti-Schlaf-Audio STARTEN
        startAntiSleepAudio();
        
        // 2. GPS-Logger
        const geoOptions = { enableHighAccuracy: true, timeout: 10000, maximumAge: 1000 };
        geoWatchId = navigator.geolocation.watchPosition(logPosition, logError, geoOptions);
        addLogEntry("DEBUG: 'geolocation.watchPosition' Listener angehängt.");
        
        // 3. Bewegungs-Sensor-Logger
        if (permissionsState.motion) {
            window.addEventListener('devicemotion', logDeviceMotion);
            addLogEntry("DEBUG: 'devicemotion' Listener angehängt.");
        } else { addLogEntry("WARNUNG: Bewegungssensor-Listener NICHT angehängt.", 'warn'); }
        
        // 4. Orientierungs-Sensor-Logger
        if (permissionsState.orientation) {
            window.addEventListener('deviceorientation', logDeviceOrientation);
            addLogEntry("DEBUG: 'deviceorientation' Listener angehängt.");
        } else { addLogEntry("WARNUNG: Orientierungssensor-Listener NICHT angehängt.", 'warn'); }
        
        isLogging = true;
        startBtn.disabled = true;
        permissionBtn.disabled = true;
        stopBtn.disabled = false;
        crashBtn.disabled = false;
        downloadBtn.disabled = true;
        fallbackToggle.disabled = true;
    }

    // ===================================
    // --- BUTTON-HANDLER (v14) ---
    // ===================================

    // PRE-FLIGHT CHECK
    permissionBtn.onclick = async () => {
        permissionBtn.disabled = true;
        startBtn.disabled = true; 
        statusEl.textContent = "Prüfe Berechtigungen...";
        logEntries = []; flightRecorderBuffer = []; logAreaEl.value = "";
        permissionsState = { gps: false, motion: false, orientation: false, network: false };
        
        const gpsOk = await requestAllPermissions();

        if (gpsOk) {
            statusEl.textContent = "Bereit zum Loggen! (GPS OK)";
            startBtn.disabled = false; downloadBtn.disabled = true; permissionBtn.disabled = true; 
            fallbackToggle.disabled = true; 
        } else {
            statusEl.textContent = "Fehler: GPS-Berechtigung benötigt!";
            permissionBtn.disabled = false; 
        }
    };

    // START
    startBtn.onclick = () => {
        logEntries = []; flightRecorderBuffer = []; logAreaEl.value = "Starte Logging...\n";
        motionSensorHasFired = false; orientationSensorHasFired = false; 
        
        addLogEntry(`Logging-Prozess angefordert (v14)...`);
        startAllLoggers();
    };

    // STOP
    stopBtn.onclick = () => {
        if (!isLogging) return;
        
        // v14: Anti-Schlaf-Audio STOPPEN
        stopAntiSleepAudio();
        
        if (geoWatchId) navigator.geolocation.clearWatch(geoWatchId);
        
        window.removeEventListener('devicemotion', logDeviceMotion);
        window.removeEventListener('deviceorientation', logDeviceOrientation);
        
        isLogging = false;
        geoWatchId = null;
        flightRecorderBuffer = [];
        addLogEntry("Logging gestoppt.");

        statusEl.textContent = "Status: Gestoppt. Download bereit.";
        startBtn.disabled = true; 
        permissionBtn.disabled = false; 
        stopBtn.disabled = true;
        crashBtn.disabled = true;
        downloadBtn.disabled = false; 
        fallbackToggle.disabled = false; 
    };

    // ABSTURZ MARKIEREN
    crashBtn.onclick = () => { 
        if (!isLogging) return;
        const markerTime = getTimestamp();
        dumpFlightRecorder(markerTime, "ABSTURZ VOM NUTZER MARKIERT");
        statusEl.textContent = "ABSTURZ MARKIERT & DUMP ERSTELLT!";
        setTimeout(() => { if(isLogging) statusEl.textContent = "LOGGING..."; }, 3000);
    };

    // DOWNLOAD
    downloadBtn.onclick = () => { 
        if (logEntries.length === 0) { alert("Keine Logs zum Herunterladen vorhanden."); return; }
        const logData = logEntries.join('\n');
        const blob = new Blob([logData], { type: 'text/plain;charset=utf-8' }); 
        const filename = `waze_log_v14_${new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-')}.txt`;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(a.href); 
    };

    // Initialen Button-Status setzen
    startBtn.disabled = true;
    stopBtn.disabled = true;
    crashBtn.disabled = true;
    downloadBtn.disabled = true;
});


