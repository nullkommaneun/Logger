/*
 * SYSTEM-DEBUGGER v2
 * ==================
 *
 * OPTIMIERUNG:
 * 1. Log-Texte aufgeräumt. "iOS-spezifisch" wurde
 * in "requestPermission API" umbenannt, basierend auf
 * unserer Entdeckung aus dem v7-Log.
 */
"use strict";

(function() {
    let debugMessages = [];

    // --- 1. Der globale Fehler-Fänger ---
    window.onerror = function(message, source, lineno, colno, error) {
        const errorMsg = `
--- !!! GLOBALER FEHLER GEFANGEN !!! ---
FEHLER: ${message}
QUELLE: ${source}
ZEILE: ${lineno}, SPALTE: ${colno}
DETAILS: ${error ? error.stack : 'Nicht verfügbar'}
--- ENDE FEHLER ---
`;
        console.error(errorMsg);
        logDebug(errorMsg);
        return true; 
    };

    // --- 2. Der System-Check ("Herz und Nieren") ---
    function runSystemCheck() {
        logDebug("--- SYSTEM-CHECK (Herz und Nieren) v2 ---");
        
        if (window.location.protocol !== 'https:'){
            logDebug("KRITISCHER FEHLER: Seite ist NICHT über HTTPS geladen!");
            logDebug("     -> APIs (GPS, Sensoren) werden FEHLSCHLAGEN.");
        } else {
            logDebug("SYSTEM-CHECK: HTTPS ... OK");
        }

        logDebug(`SYSTEM-CHECK: User Agent ... ${navigator.userAgent}`);

        // API-Verfügbarkeit
        checkApi('Geolocation', navigator.geolocation);
        checkApi('MediaDevices (Audio/BT)', navigator.mediaDevices);
        checkApi('DeviceMotionEvent (Bewegung)', window.DeviceMotionEvent);
        checkApi('DeviceOrientationEvent (Ausrichtung)', window.DeviceOrientationEvent);

        // V8-OPTIMIERUNG: Log-Text korrigiert
        if (window.DeviceMotionEvent && typeof DeviceMotionEvent.requestPermission === 'function') {
            logDebug("SYSTEM-CHECK: 'requestPermission' Motion-API ... GEFUNDEN (Erweiterte Sicherheit)");
        }
        if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function') {
            logDebug("SYSTEM-CHECK: 'requestPermission' Orientation-API ... GEFUNDEN (Erweiterte Sicherheit)");
        }
        
        logDebug("--- SYSTEM-CHECK BEENDET ---");
    }

    function checkApi(name, api) {
        if (api) {
            logDebug(`SYSTEM-CHECK: API '${name}' ... VERFÜGBAR`);
        } else {
            logDebug(`SYSTEM-CHECK: API '${name}' ... NICHT VERFÜGBAR!`, 'error');
        }
    }

    // --- Hilfsfunktionen für die Ausgabe ---
    function logDebug(message, level = 'info') {
        const timestamp = new Date().toISOString().split('T')[1].replace('Z', '');
        const logLine = `[${timestamp}] ${message}`;
        
        const outputEl = document.getElementById('debug-output');
        if (outputEl) {
            outputEl.textContent += logLine + '\n';
        } else {
            debugMessages.push(logLine);
        }
    }

    // --- Start & UI-Hooks ---
    window.addEventListener('DOMContentLoaded', () => {
        const outputEl = document.getElementById('debug-output');
        const copyBtn = document.getElementById('copyDebugBtn');

        outputEl.textContent = "Debugger v2 initialisiert...\n";
        
        if (debugMessages.length > 0) {
            outputEl.textContent += debugMessages.join('\n') + '\n';
            debugMessages = [];
        }

        try {
            runSystemCheck();
        } catch (e) {
            logDebug(`FEHLER WÄHREND SYSTEM-CHECK: ${e.message}`, 'error');
        }

        if (copyBtn) {
            copyBtn.onclick = () => {
                try {
                    const tempText = document.createElement("textarea");
                    document.body.appendChild(tempText);
                    tempText.value = outputEl.textContent;
                    tempText.select();
                    document.execCommand("copy");
                    document.body.removeChild(tempText);
                    
                    copyBtn.textContent = "Kopiert!";
                    setTimeout(() => { copyBtn.textContent = "Debug-Log kopieren"; }, 2000);
                } catch (e) {
                    copyBtn.textContent = "Fehler beim Kopieren!";
                    console.error("Kopieren fehlgeschlagen: ", e);
                }
            };
        }
    });

})();
