import symbol from './symbol';

const NAMES = new WeakMap();
export default symbol('NAME_KEY');

export function setName(obj, name) {
  if (obj !== null || typeof obj === 'object' || typeof obj === 'function')
    NAMES.set(obj, name);
}
 export function getName(obj) {
  if (obj !== null || typeof obj === 'object' || typeof obj === 'function')
    return NAMES.get(obj);
}
