/*
 When we render a rich template hierarchy, the set of events that
 *might* happen tends to be much larger than the set of events that
 actually happen. This implies that we should make listener creation &
 destruction cheap, even at the cost of making event dispatch more
 expensive.

 Thus we store a new listener with a single push and no new
 allocations, without even bothering to do deduplication -- we can
 save that for dispatch time, if an event actually happens.
 */

let currentListenerVersion = 1;

const LISTENER_KIND_ONCE = 0;
const LISTENER_KIND_ADD = 1;
const LISTENER_KIND_REMOVE = 2;
const LISTENER_KIND_REMOVE_ALL = 3;

export const protoMethods = {
  addToListeners(
    eventName,
    target,
    method,
    once
  ) {
    this.pushListener(eventName, target, method, once ? LISTENER_KIND_ONCE : LISTENER_KIND_ADD);
  },

  removeFromListeners(eventName, target, method) {
    this.pushListener(eventName, target, method, LISTENER_KIND_REMOVE);
  },

  removeAllListeners(event) {
    let listeners = this.writableListeners();
    let inheritedEnd = this._inheritedEnd;
    // remove all listeners of event name
    // adjusting the inheritedEnd if listener is below it
    for (let i = listeners.length - 1; i >= 0; i--) {
      let listener = listeners[i];
      if (listener.event === event) {
        listeners.splice(i, 1);
        if (i < inheritedEnd) {
          inheritedEnd--;
        }
      }
    }
    this._inheritedEnd = inheritedEnd;
    // we put remove alls at start because rare and easy to check there
    listeners.splice(inheritedEnd, 0, {
      event,
      target: null,
      method: null,
      kind: LISTENER_KIND_REMOVE_ALL,
    });
  },

  pushListener(
    event,
    target,
    method,
    kind
  ) {
    let listeners = this.writableListeners();

    let i = indexOfListener(listeners, event, target, method);

    // remove if found listener was inherited
    if (i !== -1 && i < this._inheritedEnd) {
      listeners.splice(i, 1);
      this._inheritedEnd--;
      i = -1;
    }

    // if not found, push
    if (i === -1) {
      listeners.push({
        event,
        target,
        method,
        kind,
      });
    } else {
      let listener = listeners[i];
      // If the listener is our own function listener and we are trying to
      // remove it, we want to splice it out entirely so we don't hold onto a
      // reference.
      if (typeof method === 'function' && kind === LISTENER_KIND_REMOVE && listener.kind !== LISTENER_KIND_REMOVE) {
        listeners.splice(i, 1);
      } else {
        // update own listener
        listener.kind = kind;
      }
    }
  },

  /**
    Flattening is based on a global revision counter. If the revision has
    bumped it means that somewhere in a class inheritance chain something has
    changed, so we need to reflatten everything. This can only happen if:
    1. A meta has been flattened (listener has been called)
    2. The meta is a prototype meta with children who have inherited its
       listeners
    3. A new listener is subsequently added to the meta (e.g. via `.reopen()`)
    This is a very rare occurence, so while the counter is global it shouldn't
    be updated very often in practice.

    @private
  */
  _shouldFlatten() {
    return this._flattenedVersion < currentListenerVersion;
  },

  _isFlattened() {
    // A meta is flattened _only_ if the saved version is equal to the current
    // version. Otherwise, it will flatten again the next time
    // `flattenedListeners` is called, so there is no reason to bump the global
    // version again.
    return this._flattenedVersion === currentListenerVersion;
  },

  _setFlattened() {
    this._flattenedVersion = currentListenerVersion;
  },

  writableListeners(){
    let listeners = this._listeners;

    if (listeners === undefined) {
      listeners = this._listeners = [];
    }

    // Check if the meta is owned by a prototype. If so, our listeners are
    // inheritable so check the meta has been flattened. If it has, children
    // have inherited its listeners, so bump the global version counter to
    // invalidate.
    if (this.source === this.proto && this._isFlattened()) {
      currentListenerVersion++;
    }

    return listeners;
  },

  flattenedListeners() {
    if (this._shouldFlatten()) {
      let parent = this.parent;

      if (parent !== undefined) {
        // compute
        let parentListeners = parent.flattenedListeners();

        if (parentListeners !== undefined) {
          let listeners = this._listeners;

          if (listeners === undefined) {
            listeners = this._listeners = [];
          }

          if (this._inheritedEnd > 0) {
            listeners.splice(0, this._inheritedEnd);
            this._inheritedEnd = 0;
          }

          for (let i = 0; i < parentListeners.length; i++) {
            let listener = parentListeners[i];
            let index = indexOfListener(
              listeners,
              listener.event,
              listener.target,
              listener.method
            );

            if (index === -1) {
              listeners.unshift(listener);
              this._inheritedEnd++;
            }
          }
        }
      }

      this._setFlattened();
    }

    return this._listeners;
  },

  matchingListeners(eventName) {
    let listeners = this.flattenedListeners();

    if (listeners !== undefined) {
      let result = [];

      for (let index = 0; index < listeners.length; index++) {
        let listener = listeners[index];

        // REMOVE and REMOVE_ALL listeners are placeholders that tell us not to
        // inherit, so they never match. Only ADD and ONCE can match.
        if (
          listener.event === eventName &&
          (listener.kind === LISTENER_KIND_ADD || listener.kind === LISTENER_KIND_ONCE)
        ) {
          result.push(listener.target, listener.method, listener.kind === LISTENER_KIND_ONCE);
        }
      }

      return result.length === 0 ? undefined : result;
    }
  }
};

function indexOfListener(
  listeners,
  event,
  target,
  method
) {
  for (let i = listeners.length - 1; i >= 0; i--) {
    let listener = listeners[i];

    if (
      listener.event === event &&
      ((listener.target === target && listener.method === method) ||
        listener.kind === LISTENER_KIND_REMOVE_ALL)
    ) {
      return i;
    }
  }
  return -1;
}
