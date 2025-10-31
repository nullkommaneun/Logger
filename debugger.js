/*
 * Waze Korrelations-Logger - System-Debugger v5
 * =============================================
 *
 * v5 fügt einen Check für die WebRTC-API hinzu,
 * die wir für den "IP-Sniffer"-Hack in app.js v15
 * benötigen.
 *
 * Lädt zuerst, prüft Systemvoraussetzungen und fängt globale Fehler.
 */
"use strict";

(function() {
    // Warten, bis das DOM-Element da ist
    document.addEventListener("DOMContentLoaded", () => {
        const debugArea = document.getElementById('debugArea');
        if (!debugArea) {
            console.error("Debugger-Fehler: Konnte <textarea id='debugArea'> nicht finden.");
            return;
        }

        function logDebug(message, level = 'info') {
            const time = new Date();
            const timestamp = `${time.getHours().toString().padStart(2, '0')}:${time.getMinutes().toString().padStart(2, '0')}:${time.getSeconds().toString().padStart(2, '0')}.${time.getMilliseconds().toString().padStart(3, '0')}`;
            const logString = `[${timestamp}] ${message}`;

            debugArea.value += logString + '\n';
            debugArea.scrollTop = debugArea.scrollHeight;

            if (level === 'error') console.error(logString);
            else if (level === 'warn') console.warn(logString);
            else console.log(logString);
        }

        window.logDebug = logDebug; // Global verfügbar machen für app.js
        logDebug(`Debugger v5 initialisiert...`);

        // --- System-Check ---
        logDebug("--- SYSTEM-CHECK (Herz und Nieren) v5 ---");

        if (window.location.protocol !== "https:") {
            logDebug("SYSTEM-CHECK: HTTPS ... FEHLER! Viele APIs benötigen HTTPS.", 'error');
        } else {
            logDebug("SYSTEM-CHECK: HTTPS ... OK");
        }

        logDebug(`SYSTEM-CHECK: User Agent ... ${navigator.userAgent}`);

        const checkApi = (name, check) => {
            try {
                if (check()) {
                    logDebug(`SYSTEM-CHECK: API '${name}' ... VERFÜGBAR`);
                    return true;
                } else {
                    logDebug(`SYSTEM-CHECK: API '${name}' ... NICHT VERFÜGBAR`, 'warn');
                    return false;
                }
            } catch (e) {
                logDebug(`SYSTEM-CHECK: API '${name}' ... FEHLER BEI PRÜFUNG (${e.message})`, 'error');
                return false;
            }
        };

        checkApi('Geolocation', () => 'geolocation' in navigator);
        checkApi('MediaDevices (Audio/BT)', () => 'mediaDevices' in navigator && 'enumerateDevices' in navigator.mediaDevices);
        checkApi('NetworkInformation (Netzwerk-Typ)', () => 'connection' in navigator || 'mozConnection' in navigator || 'webkitConnection' in navigator);
        
        // v15: WebRTC-Check
        checkApi('WebRTC (IP-Sniffer)', () => 'RTCPeerConnection' in window || 'webkitRTCPeerConnection' in window);

        // Alte Sensor APIs
        checkApi('DeviceMotionEvent (Bewegung - Alt)', () => 'DeviceMotionEvent' in window);
        checkApi('DeviceOrientationEvent (Ausrichtung - Alt)', () => 'DeviceOrientationEvent' in window);

        // Permission-Checks für alte APIs (iOS/Modern Android)
        if (typeof DeviceMotionEvent.requestPermission === 'function') {
            logDebug("SYSTEM-CHECK: 'requestPermission' Motion-API (Alt) ... GEFUNDEN (Erweiterte Sicherheit)");
        }
        if (typeof DeviceOrientationEvent.requestPermission === 'function') {
            logDebug("SYSTEM-CHECK: 'requestPermission' Orientation-API (Alt) ... GEFUNDEN (Erweiterte Sicherheit)");
        }
        
        logDebug("--- SYSTEM-CHECK BEENDET ---");

        // --- Globaler Fehler-Fänger ---
        window.onerror = function(message, source, lineno, colno, error) {
            logDebug("--- !!! GLOBALER FEHLER GEFANGEN !!! ---", 'error');
            logDebug(`FEHLER: ${message}`, 'error');
            logDebug(`QUELLE: ${source}`, 'error');
            logDebug(`ZEILE: ${lineno}, SPALTE: ${colno}`, 'error');
            if (error && error.stack) {
                logDebug(`STACK: ${error.stack}`, 'error');
            }
            logDebug("--- !!! BITTE DIESEN TEXT KOPIEREN !!! ---", 'error');
            return true;
        };

        window.onunhandledrejection = function(event) {
            logDebug("--- !!! UNBEHANDELTE PROMISE REJECTION GEFANGEN !!! ---", 'error');
            let reason = event.reason;
            if (typeof reason === 'object' && reason !== null) {
                if (reason.message) reason = reason.message;
                else reason = JSON.stringify(reason);
            }
            logDebug(`GRUND: ${reason}`, 'error');
            if (event.reason && event.reason.stack) {
                logDebug(`STACK: ${event.reason.stack}`, 'error');
            }
            logDebug("--- !!! BITTE DIESEN TEXT KOPIEREN !!! ---", 'error');
        };
    });
})();
