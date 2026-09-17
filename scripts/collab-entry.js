// Punkt wejścia zvendorowanego bundle'a. To jedyne miejsce, które decyduje,
// co z Yjs i y-webrtc trafia do renderera — reszta biblioteki zostaje w środku.
//
// Bundle powstaje przez `npm run vendor` i jest commitowany do repo.
// Nie uruchamiaj tego pliku wprost i nie ładuj go przez <script>.
import * as Y from 'yjs';
import { WebrtcProvider } from 'y-webrtc';
import * as awarenessProtocol from 'y-protocols/awareness';

globalThis.Collab = { Y, WebrtcProvider, awarenessProtocol };
