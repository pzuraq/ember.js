import CoreObject, { POST_INIT } from '../../system/core_object';
import { set, observer } from 'ember-metal';

QUnit.module('Ember.CoreObject');

QUnit.test('toString should be not be added as a property when calling toString()', function(assert) {
  let obj = new CoreObject({
    firstName: 'Foo',
    lastName: 'Bar'
  });

  obj.toString();

  assert.notOk(obj.hasOwnProperty('toString'), 'Calling toString() should not create a toString class property');
});

QUnit.test('[POST_INIT] invoked during construction', function(assert) {
  let callCount = 0;
  let Obj = CoreObject.extend({
    [POST_INIT]() {
      callCount++;
    }
  });

  assert.equal(callCount, 0);

  Obj.create();

  assert.equal(callCount, 1);
});

QUnit.test('[POST_INIT] invoked before finishChains', function(assert) {
  let callCount = 0;

  let Obj = CoreObject.extend({
    [POST_INIT]() {
      set(this, 'hi', 1);
    },

    hiDidChange: observer('hi', function() {
      callCount++;
    })
  });

  assert.equal(callCount, 0);

  let obj = Obj.create();

  assert.equal(callCount, 0);

  set(obj, 'hi', 2);

  assert.equal(callCount, 1);
});
