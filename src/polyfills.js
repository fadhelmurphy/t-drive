// Must be the first import of the app: GramJS uses the global Buffer.
import { Buffer } from 'buffer';

globalThis.Buffer = Buffer;
