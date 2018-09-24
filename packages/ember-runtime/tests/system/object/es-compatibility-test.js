import EmberObject from '../../../system/object';
import {
  Mixin,
  observer,
  on,
  removeObserver,
  removeListener,
  sendEvent,
} from 'ember-metal';

QUnit.module('EmberObject ES Compatibility');

QUnit.test('extending an Ember.Object', function(assert) {
  let calls = [];

  class MyObject extends EmberObject {
    constructor() {
      calls.push('constructor');
      super(...arguments);
      this.postInitProperty = 'post-init-property';
    }

    init() {
      calls.push('init');
      super.init(...arguments);
      this.initProperty = 'init-property';
    }
  }

  let myObject = MyObject.create({ passedProperty: 'passed-property' });

  assert.deepEqual(calls, ['constructor', 'init'], 'constructor then init called (create)');
  assert.equal(myObject.postInitProperty, 'post-init-property', 'constructor property available on instance (create)');
  assert.equal(myObject.initProperty, 'init-property', 'init property available on instance (create)');
  assert.equal(myObject.passedProperty, 'passed-property', 'passed property available on instance (create)');

  calls = [];
  myObject = new MyObject({ passedProperty: 'passed-property' });

  assert.deepEqual(calls, ['constructor', 'init'], 'constructor then init called (new)');
  assert.equal(myObject.postInitProperty, 'post-init-property', 'constructor property available on instance (new)');
  assert.equal(myObject.initProperty, 'init-property', 'init property available on instance (new)');
  assert.equal(myObject.passedProperty, 'passed-property', 'passed property available on instance (new)');
});

QUnit.test('using super', function(assert) {
  let calls = [];

  let SuperSuperObject = EmberObject.extend({
    method() {
      calls.push('super-super-method');
    }
  });

  let SuperObject = SuperSuperObject.extend({
    method() {
      this._super();
      calls.push('super-method');
    }
  });

  class MyObject extends SuperObject {
    method() {
      super.method();
      calls.push('method');
    }
  }

  let myObject = new MyObject();
  myObject.method();

  assert.deepEqual(calls, [
    'super-super-method',
    'super-method',
    'method'
  ], 'chain of prototype methods called with super');
});

QUnit.test('using mixins', function(assert) {
  let Mixin1 = Mixin.create({
    property1: 'data-1'
  });

  let Mixin2 = Mixin.create({
    property2: 'data-2'
  });

  class MyObject extends EmberObject.extend(Mixin1, Mixin2) {}

  let myObject = new MyObject();
  assert.equal(myObject.property1, 'data-1', 'includes the first mixin');
  assert.equal(myObject.property2, 'data-2', 'includes the second mixin');
});

QUnit.test('using instanceof', function(assert) {
  class MyObject extends EmberObject {}

  let myObject1 = MyObject.create();
  let myObject2 = new MyObject();

  assert.ok(myObject1 instanceof MyObject);
  assert.ok(myObject1 instanceof EmberObject);

  assert.ok(myObject2 instanceof MyObject);
  assert.ok(myObject2 instanceof EmberObject);
});

QUnit.test('extending an ES subclass of EmberObject', function(assert) {
  let calls = [];

  class SubEmberObject extends EmberObject {
    constructor() {
      calls.push('constructor');
      super(...arguments);
    }

    init() {
      calls.push('init');
      super.init(...arguments);
    }
  }

  class MyObject extends SubEmberObject {}

  MyObject.create();
  assert.deepEqual(calls, ['constructor', 'init'], 'constructor then init called (create)');

  calls = [];
  new MyObject();
  assert.deepEqual(calls, ['constructor', 'init'], 'constructor then init called (new)');
});

QUnit.test('@observes / removeObserver on / removeListener interop', function(assert) {
  let fooDidChangeBase = 0;
  let fooDidChangeA = 0;
  let fooDidChangeB = 0;
  let someEventBase = 0;
  let someEventA = 0;
  let someEventB = 0;

  class A extends EmberObject.extend({
    fooDidChange: observer('foo', function() {
      fooDidChangeBase++;
    }),
     onSomeEvent: on('someEvent', function() {
      someEventBase++;
    }),
  }) {
    init() {
      super.init();
      this.foo = 'bar';
    }
     fooDidChange() {
      super.fooDidChange();
      fooDidChangeA++;
    }
     onSomeEvent() {
      super.onSomeEvent();
      someEventA++;
    }
  }

  class B extends A {
    fooDidChange() {
      super.fooDidChange();
      fooDidChangeB++;
    }
     onSomeEvent() {
      super.onSomeEvent();
      someEventB++;
    }
  }

  removeObserver(B.prototype, 'foo', null, 'fooDidChange');
  removeListener(B.prototype, 'someEvent', null, 'onSomeEvent');

  assert.equal(fooDidChangeBase, 0);
  assert.equal(fooDidChangeA, 0);
  assert.equal(fooDidChangeB, 0);

  assert.equal(someEventBase, 0);
  assert.equal(someEventA, 0);
  assert.equal(someEventB, 0);

  let a = new A();
  a.set('foo', 'something');
  assert.equal(fooDidChangeBase, 1);
  assert.equal(fooDidChangeA, 1);
  assert.equal(fooDidChangeB, 0);

  sendEvent(a, 'someEvent');
  assert.equal(someEventBase, 1);
  assert.equal(someEventA, 1);
  assert.equal(someEventB, 0);

  let b = new B();
  b.set('foo', 'something');
  assert.equal(fooDidChangeBase, 1);
  assert.equal(fooDidChangeA, 1);
  assert.equal(fooDidChangeB, 0);

  sendEvent(b, 'someEvent');
  assert.equal(someEventBase, 1);
  assert.equal(someEventA, 1);
  assert.equal(someEventB, 0);
});

// TODO: Needs to be fixed. Currently only `init` is called.
QUnit.skip('calling extend on an ES subclass of EmberObject', function(assert) {
  let calls = [];

  class SubEmberObject extends EmberObject {
    constructor() {
      calls.push('constructor');
      super(...arguments);
    }

    init() {
      calls.push('init');
      super.init(...arguments);
    }
  }

  let MyObject = SubEmberObject.extend({});

  MyObject.create();
  assert.deepEqual(calls, ['constructor', 'init'], 'constructor then init called (create)');

  calls = [];
  new MyObject();
  assert.deepEqual(calls, ['constructor', 'init'], 'constructor then init called (new)');
});
