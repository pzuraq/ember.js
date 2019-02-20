import { Meta, meta as metaFor, peekMeta } from '@ember/-internals/meta';
import { inspect, toString } from '@ember/-internals/utils';
import {
  EMBER_METAL_TRACKED_PROPERTIES,
  EMBER_NATIVE_DECORATOR_SUPPORT,
} from '@ember/canary-features';
import { assert, deprecate, warn } from '@ember/debug';
import EmberError from '@ember/error';
import {
  getCachedValueFor,
  getCacheFor,
  getLastRevisionFor,
  peekCacheFor,
  setLastRevisionFor,
} from './computed_cache';
import {
  addDependentKeys,
  ComputedDescriptor,
  Decorator,
  DecoratorPropertyDescriptor,
  isElementDescriptor,
  makeComputedDecorator,
  removeDependentKeys,
} from './decorator';
import { descriptorForDecorator, isComputedDecorator } from './descriptor_map';
import expandProperties from './expand_properties';
import { defineProperty } from './properties';
import { notifyPropertyChange } from './property_events';
import { set } from './property_set';
import { tagForProperty, update } from './tags';
import { getCurrentTracker, setCurrentTracker } from './tracked';

export type ComputedPropertyGetter = (keyName: string) => any;
export type ComputedPropertySetter = (keyName: string, value: any, cachedValue?: any) => any;

export interface ComputedPropertyGetterAndSetter {
  get?: ComputedPropertyGetter;
  set?: ComputedPropertySetter;
}
export type ComputedPropertyConfig = ComputedPropertyGetter | ComputedPropertyGetterAndSetter;

/**
@module @ember/object
*/

const DEEP_EACH_REGEX = /\.@each\.[^.]+\./;

function noop(): void {}
/**
  A computed property transforms an object literal with object's accessor function(s) into a property.

  By default the function backing the computed property will only be called
  once and the result will be cached. You can specify various properties
  that your computed property depends on. This will force the cached
  result to be recomputed if the dependencies are modified.

  In the following example we declare a computed property - `fullName` - by calling
  `computed` with property dependencies (`firstName` and `lastName`) as leading arguments and getter accessor function. The `fullName` getter function
  will be called once (regardless of how many times it is accessed) as long
  as its dependencies have not changed. Once `firstName` or `lastName` are updated
  any future calls (or anything bound) to `fullName` will incorporate the new
  values.

  ```javascript
  import EmberObject, { computed } from '@ember/object';

  let Person = EmberObject.extend({
    // these will be supplied by `create`
    firstName: null,
    lastName: null,

    fullName: computed('firstName', 'lastName', function() {
      let firstName = this.get('firstName'),
          lastName  = this.get('lastName');

      return `${firstName} ${lastName}`;
    })
  });

  let tom = Person.create({
    firstName: 'Tom',
    lastName: 'Dale'
  });

  tom.get('fullName') // 'Tom Dale'
  ```

  You can also define what Ember should do when setting a computed property by providing additional function (`set`) in hash argument.
  If you try to set a computed property, it will try to invoke setter accessor function with the key and
  value you want to set it to as arguments.

  ```javascript
  import EmberObject, { computed } from '@ember/object';

  let Person = EmberObject.extend({
    // these will be supplied by `create`
    firstName: null,
    lastName: null,

    fullName: computed('firstName', 'lastName', {
      get(key) {
        let firstName = this.get('firstName'),
            lastName  = this.get('lastName');

        return firstName + ' ' + lastName;
      },
      set(key, value) {
        let [firstName, lastName] = value.split(' ');

        this.set('firstName', firstName);
        this.set('lastName', lastName);

        return value;
      }
    })
  });

  let person = Person.create();

  person.set('fullName', 'Peter Wagenet');
  person.get('firstName'); // 'Peter'
  person.get('lastName');  // 'Wagenet'
  ```

  You can overwrite computed property with normal property (no longer computed), that won't change if dependencies change, if you set computed property and it won't have setter accessor function defined.

  You can also mark computed property as `.readOnly()` and block all attempts to set it.

  ```javascript
  import EmberObject, { computed } from '@ember/object';

  let Person = EmberObject.extend({
    // these will be supplied by `create`
    firstName: null,
    lastName: null,

    fullName: computed('firstName', 'lastName', {
      get(key) {
        let firstName = this.get('firstName');
        let lastName  = this.get('lastName');

        return firstName + ' ' + lastName;
      }
    }).readOnly()
  });

  let person = Person.create();
  person.set('fullName', 'Peter Wagenet'); // Uncaught Error: Cannot set read-only property "fullName" on object: <(...):emberXXX>
  ```

  Additional resources:
  - [New CP syntax RFC](https://github.com/emberjs/rfcs/blob/master/text/0011-improved-cp-syntax.md)
  - [New computed syntax explained in "Ember 1.12 released" ](https://emberjs.com/blog/2015/05/13/ember-1-12-released.html#toc_new-computed-syntax)

  @class ComputedProperty
  @public
*/
export class ComputedProperty extends ComputedDescriptor {
  private _volatile = false;
  private _readOnly = false;
  private _suspended: any = undefined;
  private _hasConfig = false;

  _getter?: ComputedPropertyGetter = undefined;
  _setter?: ComputedPropertySetter = undefined;
  _auto?: boolean;

  constructor(args: Array<string | ComputedPropertyConfig>) {
    super();

    let maybeConfig = args[args.length - 1];

    if (
      typeof maybeConfig === 'function' ||
      (maybeConfig !== null && typeof maybeConfig === 'object')
    ) {
      this._hasConfig = true;
      let config = args.pop();

      if (typeof config === 'function') {
        assert(
          `You attempted to pass a computed property instance to computed(). Computed property instances are decorator functions, and cannot be passed to computed() because they cannot be turned into decorators twice`,
          !isComputedDecorator(config)
        );

        this._getter = config as ComputedPropertyGetter;
      } else {
        const objectConfig = config as ComputedPropertyGetterAndSetter;
        assert(
          'computed expects a function or an object as last argument.',
          typeof objectConfig === 'object' && !Array.isArray(objectConfig)
        );
        assert(
          'Config object passed to computed can only contain `get` and `set` keys.',
          Object.keys(objectConfig).every(key => key === 'get' || key === 'set')
        );
        assert(
          'Computed properties must receive a getter or a setter, you passed none.',
          Boolean(objectConfig.get) || Boolean(objectConfig.set)
        );
        this._getter = objectConfig.get || noop;
        this._setter = objectConfig.set;
      }
    }

    if (args.length > 0) {
      this._property(...(args as string[]));
    }

    if (EMBER_METAL_TRACKED_PROPERTIES) {
      this._auto = false;
    }
  }

  setup(obj: object, keyName: string, propertyDesc: DecoratorPropertyDescriptor, meta: Meta) {
    super.setup(obj, keyName, propertyDesc, meta);

    assert(
      `@computed can only be used on accessors or fields, attempted to use it with ${keyName} but that was a method. Try converting it to a getter (e.g. \`get ${keyName}() {}\`)`,
      !(propertyDesc && typeof propertyDesc.value === 'function')
    );

    assert(
      `@computed can only be used on empty fields. ${keyName} has an initial value (e.g. \`${keyName} = someValue\`)`,
      !propertyDesc || !propertyDesc.initializer
    );

    assert(
      `Attempted to apply a computed property that already has a getter/setter to a ${keyName}, but it is a method or an accessor. If you passed @computed a function or getter/setter (e.g. \`@computed({ get() { ... } })\`), then it must be applied to a field`,
      !(
        this._hasConfig &&
        propertyDesc &&
        (typeof propertyDesc.get === 'function' || typeof propertyDesc.set === 'function')
      )
    );

    if (this._hasConfig === false) {
      assert(
        `Attempted to use @computed on ${keyName}, but it did not have a getter or a setter. You must either pass a get a function or getter/setter to @computed directly (e.g. \`@computed({ get() { ... } })\`) or apply @computed directly to a getter/setter`,
        propertyDesc &&
          (typeof propertyDesc.get === 'function' || typeof propertyDesc.set === 'function')
      );

      let { get, set } = propertyDesc!;

      if (get !== undefined) {
        this._getter = get as ComputedPropertyGetter;
      }

      if (set !== undefined) {
        this._setter = function setterWrapper(_key, value) {
          let ret = set!.call(this, value);

          if (get !== undefined) {
            return typeof ret === 'undefined' ? get.call(this) : ret;
          }

          return ret;
        };
      }
    }
  }

  /**
    Call on a computed property to set it into non-cached mode. When in this
    mode the computed property will not automatically cache the return value.
    It also does not automatically fire any change events. You must manually notify
    any changes if you want to observe this property.
    Dependency keys have no effect on volatile properties as they are for cache
    invalidation and notification when cached value is invalidated.
    ```javascript
    import EmberObject, { computed } from '@ember/object';
    let outsideService = EmberObject.extend({
      value: computed(function() {
        return OutsideService.getValue();
      }).volatile()
    }).create();
    ```
    @method volatile
    @return {ComputedProperty} this
    @chainable
    @public
  */
  volatile(): void {
    deprecate(
      'Setting a computed property as volatile has been deprecated. Instead, consider using a native getter with native class syntax.',
      false,
      {
        id: 'computed-property.volatile',
        until: '4.0.0',
        url: 'https://emberjs.com/deprecations/v3.x#toc_computed-property-volatile',
      }
    );

    this._volatile = true;
  }

  /**
    Call on a computed property to set it into read-only mode. When in this
    mode the computed property will throw an error when set.
    ```javascript
    import EmberObject, { computed } from '@ember/object';
    let Person = EmberObject.extend({
      guid: computed(function() {
        return 'guid-guid-guid';
      }).readOnly()
    });
    let person = Person.create();
    person.set('guid', 'new-guid'); // will throw an exception
    ```
    @method readOnly
    @return {ComputedProperty} this
    @chainable
    @public
  */
  readOnly(): void {
    this._readOnly = true;
    assert(
      'Computed properties that define a setter using the new syntax cannot be read-only',
      !(this._readOnly && this._setter && this._setter !== this._getter)
    );
  }

  /**
    Sets the dependent keys on this computed property. Pass any number of
    arguments containing key paths that this computed property depends on.
    ```javascript
    import EmberObject, { computed } from '@ember/object';
    let President = EmberObject.extend({
      fullName: computed('firstName', 'lastName', function() {
        return this.get('firstName') + ' ' + this.get('lastName');
        // Tell Ember that this computed property depends on firstName
        // and lastName
      })
    });
    let president = President.create({
      firstName: 'Barack',
      lastName: 'Obama'
    });
    president.get('fullName'); // 'Barack Obama'
    ```
    @method property
    @param {String} path* zero or more property paths
    @return {ComputedProperty} this
    @chainable
    @public
  */
  property(...passedArgs: string[]): void {
    deprecate(
      'Setting dependency keys using the `.property()` modifier has been deprecated. Pass the dependency keys directly to computed as arguments instead. If you are using `.property()` on a computed property macro, consider refactoring your macro to receive additional dependent keys in its initial declaration.',
      false,
      {
        id: 'computed-property.property',
        until: '4.0.0',
        url: 'https://emberjs.com/deprecations/v3.x#toc_computed-property-property',
      }
    );

    this._property(...passedArgs);
  }

  _property(...passedArgs: string[]): void {
    let args: string[] = [];

    function addArg(property: string): void {
      warn(
        `Dependent keys containing @each only work one level deep. ` +
          `You used the key "${property}" which is invalid. ` +
          `Please create an intermediary computed property.`,
        DEEP_EACH_REGEX.test(property) === false,
        { id: 'ember-metal.computed-deep-each' }
      );
      args.push(property);
    }

    for (let i = 0; i < passedArgs.length; i++) {
      expandProperties(passedArgs[i], addArg);
    }

    this._dependentKeys = args;
  }

  /**
    In some cases, you may want to annotate computed properties with additional
    metadata about how they function or what values they operate on. For example,
    computed property functions may close over variables that are then no longer
    available for introspection.
    You can pass a hash of these values to a computed property like this:
    ```
    import { computed } from '@ember/object';
    import Person from 'my-app/utils/person';
    person: computed(function() {
      let personId = this.get('personId');
      return Person.create({ id: personId });
    }).meta({ type: Person })
    ```
    The hash that you pass to the `meta()` function will be saved on the
    computed property descriptor under the `_meta` key. Ember runtime
    exposes a public API for retrieving these values from classes,
    via the `metaForProperty()` function.
    @method meta
    @param {Object} meta
    @chainable
    @public
  */

  // invalidate cache when CP key changes
  didChange(obj: object, keyName: string): void {
    // _suspended is set via a CP.set to ensure we don't clear
    // the cached value set by the setter
    if (this._volatile || this._suspended === obj) {
      return;
    }

    // don't create objects just to invalidate
    let meta = peekMeta(obj);
    if (meta === null || meta.source !== obj) {
      return;
    }

    let cache = peekCacheFor(obj);
    if (cache !== undefined && cache.delete(keyName)) {
      removeDependentKeys(this, obj, keyName, meta);
    }
  }

  get(obj: object, keyName: string): any {
    if (this._volatile) {
      return this._getter!.call(obj, keyName);
    }

    let cache = getCacheFor(obj);
    let propertyTag;

    if (EMBER_METAL_TRACKED_PROPERTIES) {
      propertyTag = tagForProperty(obj, keyName);

      if (cache.has(keyName)) {
        // special-case for computed with no dependent keys used to
        // trigger cacheable behavior.
        if (!this._auto && (!this._dependentKeys || this._dependentKeys.length === 0)) {
          return cache.get(keyName);
        }

        let lastRevision = getLastRevisionFor(obj, keyName);
        if (propertyTag.validate(lastRevision)) {
          return cache.get(keyName);
        }
      }
    } else {
      if (cache.has(keyName)) {
        return cache.get(keyName);
      }
    }

    let parent: any;
    let tracker: any;

    if (EMBER_METAL_TRACKED_PROPERTIES) {
      parent = getCurrentTracker();
      tracker = setCurrentTracker();
    }

    let ret = this._getter!.call(obj, keyName);

    if (EMBER_METAL_TRACKED_PROPERTIES) {
      setCurrentTracker(parent!);
      let tag = tracker!.combine();
      if (parent) parent.add(tag);

      update(propertyTag as any, tag);
      setLastRevisionFor(obj, keyName, (propertyTag as any).value());
    }

    cache.set(keyName, ret);

    let meta = metaFor(obj);
    let chainWatchers = meta.readableChainWatchers();
    if (chainWatchers !== undefined) {
      chainWatchers.revalidate(keyName);
    }
    addDependentKeys(this, obj, keyName, meta);

    return ret;
  }

  set(obj: object, keyName: string, value: any): any {
    if (this._readOnly) {
      this._throwReadOnlyError(obj, keyName);
    }

    if (!this._setter) {
      return this.clobberSet(obj, keyName, value);
    }

    if (this._volatile) {
      return this.volatileSet(obj, keyName, value);
    }

    return this.setWithSuspend(obj, keyName, value);
  }

  _throwReadOnlyError(obj: object, keyName: string): never {
    throw new EmberError(`Cannot set read-only property "${keyName}" on object: ${inspect(obj)}`);
  }

  clobberSet(obj: object, keyName: string, value: any): any {
    deprecate(
      `The ${toString(
        obj
      )}#${keyName} computed property was just overriden. This removes the computed property and replaces it with a plain value, and has been deprecated. If you want this behavior, consider defining a setter which does it manually.`,
      false,
      {
        id: 'computed-property.override',
        until: '4.0.0',
        url: 'https://emberjs.com/deprecations/v3.x#toc_computed-property-override',
      }
    );

    let cachedValue = getCachedValueFor(obj, keyName);
    defineProperty(obj, keyName, null, cachedValue);
    set(obj, keyName, value);
    return value;
  }

  volatileSet(obj: object, keyName: string, value: any): any {
    return this._setter!.call(obj, keyName, value);
  }

  setWithSuspend(obj: object, keyName: string, value: any): any {
    let oldSuspended = this._suspended;
    this._suspended = obj;
    try {
      return this._set(obj, keyName, value);
    } finally {
      this._suspended = oldSuspended;
    }
  }

  _set(obj: object, keyName: string, value: any): any {
    let cache = getCacheFor(obj);
    let hadCachedValue = cache.has(keyName);
    let cachedValue = cache.get(keyName);

    let ret = this._setter!.call(obj, keyName, value, cachedValue);

    // allows setter to return the same value that is cached already
    if (hadCachedValue && cachedValue === ret) {
      return ret;
    }

    let meta = metaFor(obj);
    if (!hadCachedValue) {
      addDependentKeys(this, obj, keyName, meta);
    }

    cache.set(keyName, ret);

    notifyPropertyChange(obj, keyName, meta);

    if (EMBER_METAL_TRACKED_PROPERTIES) {
      let propertyTag = tagForProperty(obj, keyName);
      setLastRevisionFor(obj, keyName, propertyTag.value());
    }

    return ret;
  }

  /* called before property is overridden */
  teardown(obj: object, keyName: string, meta?: any): void {
    if (!this._volatile) {
      let cache = peekCacheFor(obj);
      if (cache !== undefined && cache.delete(keyName)) {
        removeDependentKeys(this, obj, keyName, meta);
      }
    }
    super.teardown(obj, keyName, meta);
  }

  auto!: () => ComputedProperty;
}

if (EMBER_METAL_TRACKED_PROPERTIES) {
  ComputedProperty.prototype.auto = function(): ComputedProperty {
    this._auto = true;
    return this;
  };
}

export type ComputedDecorator = Decorator & PropertyDecorator & ComputedDecoratorImpl;

// TODO: This class can be svelted once `meta` has been deprecated
class ComputedDecoratorImpl extends Function {
  readOnly(this: Decorator) {
    (descriptorForDecorator(this) as ComputedProperty).readOnly();
    return this;
  }

  volatile(this: Decorator) {
    (descriptorForDecorator(this) as ComputedProperty).volatile();
    return this;
  }

  property(this: Decorator, ...keys: string[]) {
    (descriptorForDecorator(this) as ComputedProperty).property(...keys);
    return this;
  }

  meta(this: Decorator, meta?: any): any {
    let prop = descriptorForDecorator(this) as ComputedProperty;

    if (arguments.length === 0) {
      return prop._meta || {};
    } else {
      prop._meta = meta;
      return this;
    }
  }

  set enumerable(this: Decorator, value: boolean) {
    (descriptorForDecorator(this) as ComputedProperty).enumerable = value;
  }
}

/**
  This helper returns a new property descriptor that wraps the passed
  computed property function. You can use this helper to define properties
  with mixins or via `defineProperty()`.

  If you pass a function as an argument, it will be used as a getter. A computed
  property defined in this way might look like this:

  ```js
  import EmberObject, { computed } from '@ember/object';

  let Person = EmberObject.extend({
    init() {
      this._super(...arguments);

      this.firstName = 'Betty';
      this.lastName = 'Jones';
    },

    fullName: computed('firstName', 'lastName', function() {
      return `${this.get('firstName')} ${this.get('lastName')}`;
    })
  });

  let client = Person.create();

  client.get('fullName'); // 'Betty Jones'

  client.set('lastName', 'Fuller');
  client.get('fullName'); // 'Betty Fuller'
  ```

  You can pass a hash with two functions, `get` and `set`, as an
  argument to provide both a getter and setter:

  ```js
  import EmberObject, { computed } from '@ember/object';

  let Person = EmberObject.extend({
    init() {
      this._super(...arguments);

      this.firstName = 'Betty';
      this.lastName = 'Jones';
    },

    fullName: computed('firstName', 'lastName', {
      get(key) {
        return `${this.get('firstName')} ${this.get('lastName')}`;
      },
      set(key, value) {
        let [firstName, lastName] = value.split(/\s+/);
        this.setProperties({ firstName, lastName });
        return value;
      }
    })
  });

  let client = Person.create();
  client.get('firstName'); // 'Betty'

  client.set('fullName', 'Carroll Fuller');
  client.get('firstName'); // 'Carroll'
  ```

  The `set` function should accept two parameters, `key` and `value`. The value
  returned from `set` will be the new value of the property.

  _Note: This is the preferred way to define computed properties when writing third-party
  libraries that depend on or use Ember, since there is no guarantee that the user
  will have [prototype Extensions](https://guides.emberjs.com/release/configuring-ember/disabling-prototype-extensions/) enabled._

  The alternative syntax, with prototype extensions, might look like:

  ```js
  fullName: function() {
    return this.get('firstName') + ' ' + this.get('lastName');
  }.property('firstName', 'lastName')
  ```

  @method computed
  @for @ember/object
  @static
  @param {String} [dependentKeys*] Optional dependent keys that trigger this computed property.
  @param {Function} func The computed property function.
  @return {ComputedDecorator} property decorator instance
  @public
*/
export function computed(target: object, key: string, desc: PropertyDescriptor): PropertyDescriptor;
export function computed(...args: (string | ComputedPropertyConfig)[]): ComputedDecorator;
export function computed(
  ...args: (object | string | ComputedPropertyConfig | DecoratorPropertyDescriptor)[]
): ComputedDecorator | DecoratorPropertyDescriptor {
  assert(
    `@computed can only be used directly as a native decorator. If you're using tracked in classic classes, add parenthesis to call it like a function: computed()`,
    !(isElementDescriptor(args.slice(0, 3)) && args.length === 5 && args[4] === true)
  );

  if (isElementDescriptor(args)) {
    assert(
      'Native decorators are not enabled without the EMBER_NATIVE_DECORATOR_SUPPORT flag. If you are using computed in a classic class, add parenthesis to it: computed()',
      Boolean(EMBER_NATIVE_DECORATOR_SUPPORT)
    );

    let decorator = makeComputedDecorator(
      new ComputedProperty([]),
      ComputedDecoratorImpl
    ) as ComputedDecorator;

    return decorator(args[0], args[1], args[2]);
  }

  return makeComputedDecorator(
    new ComputedProperty(args as (string | ComputedPropertyConfig)[]),
    ComputedDecoratorImpl
  ) as ComputedDecorator;
}

export const _globalsComputed = computed.bind(null);

export default computed;
