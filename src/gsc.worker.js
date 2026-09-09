import { gscTokens } from "./gsc-tokens.js";
self.onmessage = ({ data }) => self.postMessage(gscTokens(data));
