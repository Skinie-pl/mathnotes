// Punkt wejścia zvendorowanego bundle'a. To jedyne miejsce, które decyduje,
// co z Yjs i y-webrtc trafia do renderera — reszta biblioteki zostaje w środku.
//
// Bundle powstaje przez `npm run vendor` i jest commitowany do repo.
// Nie uruchamiaj tego pliku wprost i nie ładuj go przez <script>.
import * as Y from 'yjs';
import { WebrtcProvider } from 'y-webrtc';
import * as awarenessProtocol from 'y-protocols/awareness';
// Dokładnie ten sam moduł, którego używa y-webrtc — gotowy build przeglądarkowy.
// Import zwykłego 'simple-peer' dałby inną klasę i łatka nie miałaby efektu.
import Peer from 'simple-peer/simplepeer.min.js';
import { patchPeer } from './webrtc-frames.js';

// Bez tego jedna duża aktualizacja (wklejony obraz, pierwsza synchronizacja
// notatnika z obrazami) przekracza limit wiadomości kanału WebRTC, zamyka go
// i sesja przestaje przesyłać cokolwiek.
patchPeer(Peer);

globalThis.Collab = { Y, WebrtcProvider, awarenessProtocol };
