/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Jetpack.
 *
 * The Initial Developer of the Original Code is Mozilla.
 * Portions created by the Initial Developer are Copyright (C) 2007
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Atul Varma <atul@mozilla.com>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

var cService = Cc['@mozilla.org/consoleservice;1'].getService()
               .QueryInterface(Ci.nsIConsoleService);

// Cuddlefish loader for the sandbox in which we load and
// execute tests.
var sandbox;

// Function to call when we're done running tests.
var onDone;

// Function to print text to a console, w/o CR at the end.
var print;

// The directories to look for tests in.
var dirs;

// How many more times to run all tests.
var iterationsLeft;

// Information on memory profiler binary component (optional).
var profiler;

// Combined results from all test runs.
var results = {passed: 0,
               failed: 0};

function analyzeRawProfilingData(data) {
  var graph = data.graph;
  var shapes = {};

  // Convert keys in the graph from strings to ints.
  // TODO: Can we get rid of this ridiculousness?
  var newGraph = {};
  for (id in graph) {
    newGraph[parseInt(id)] = graph[id];
  }
  graph = newGraph;

  var modules = 0;
  var moduleIds = [];
  var moduleObjs = {UNKNOWN: 0};
  for (name in data.namedObjects) {
    moduleObjs[name] = 0;
    moduleIds[data.namedObjects[name]] = name;
    modules++;
  }

  var count = 0;
  for (id in graph) {
    var parent = graph[id].parent;
    while (parent) {
      if (parent in moduleIds) {
        var name = moduleIds[parent];
        moduleObjs[name]++;
        break;
      }
      if (!(parent in graph)) {
        moduleObjs.UNKNOWN++;
        break;
      }
      parent = graph[parent].parent;
    }
    count++;
  }

  print("\nobject count is " + count + " in " + modules + " modules\n");
  for (name in moduleObjs)
    print("  " + moduleObjs[name] + " in " + name + "\n");
}

function reportMemoryUsage() {
  memory.gc();

  if (profiler) {
    var namedObjects = {};
    for (url in sandbox.sandboxes)
      namedObjects[url] = sandbox.sandboxes[url].globalScope;

    var result = profiler.binary.profileMemory(profiler.script,
                                               profiler.scriptUrl,
                                               1,
                                               namedObjects);
    result = JSON.parse(result);
    if (result.success)
      analyzeRawProfilingData(result.data);
  }

  var mgr = Cc["@mozilla.org/memory-reporter-manager;1"]
            .getService(Ci.nsIMemoryReporterManager);
  var reporters = mgr.enumerateReporters();
  if (reporters.hasMoreElements())
    print("\n");
  while (reporters.hasMoreElements()) {
    var reporter = reporters.getNext();
    reporter.QueryInterface(Ci.nsIMemoryReporter);
    print(reporter.description + ": " + reporter.memoryUsed + "\n");
  }

  var weakrefs = [info.weakref.get()
                  for each (info in sandbox.memory.getObjects())];
  weakrefs = [weakref for each (weakref in weakrefs) if (weakref)];
  print("Tracked memory objects in testing sandbox: " +
        weakrefs.length + "\n");
}

function cleanup() {
  try {
    for (name in sandbox.sandboxes)
      sandbox.memory.track(sandbox.sandboxes[name].globalScope,
                           "module global scope: " + name);
    sandbox.memory.track(sandbox, "Cuddlefish Loader");

    var weakrefs = [info.weakref
                    for each (info in sandbox.memory.getObjects())];

    sandbox.unload();
    sandbox = null;

    memory.gc();

    weakrefs.forEach(
      function(weakref) {
        var ref = weakref.get();
        if (ref !== null) {
          var data = ref.__url__ ? ref.__url__ : ref;
          console.warn("LEAK", data);
        }
      });
  } catch (e) {
    results.failed++;
    console.error("unload.send() threw an exception.");
    console.exception(e);
  };

  print("\n");
  var total = results.passed + results.failed;
  print(results.passed + " of " + total + " tests passed.\n");
  onDone(results);
}

function nextIteration(tests) {
  if (tests) {
    results.passed += tests.passed;
    results.failed += tests.failed;
    reportMemoryUsage();
    iterationsLeft--;
  }
  if (iterationsLeft)
    sandbox.require("unit-test").findAndRunTests({dirs: dirs,
                                                  onDone: nextIteration});
  else
    require("timer").setTimeout(cleanup, 0);
}

var POINTLESS_ERRORS = [
  "Invalid chrome URI:"
];

var consoleListener = {
  observe: function(object) {
    var message = object.QueryInterface(Ci.nsIConsoleMessage).message;
    var pointless = [err for each (err in POINTLESS_ERRORS)
                         if (message.indexOf(err) == 0)];
    if (pointless.length == 0)
      print("console: " + message);
  }
};

function TestRunnerConsole(base, options) {
  this.__proto__ = {
    info: function info(first) {
      if (options.verbose)
        base.info.apply(base, arguments);
      else
        if (first == "pass:")
          print(".");
    },
    __proto__: base
  };
}

var runTests = exports.runTests = function runTests(options) {
  iterationsLeft = options.iterations;
  onDone = options.onDone;
  print = options.print;

  try {
    cService.registerListener(consoleListener);

    var cuddlefish = require("cuddlefish");
    var ptc = require("plain-text-console");
    var url = require("url");

    try {
      var klass = Cc["@labs.mozilla.com/jetpackdi;1"];
      if (klass) {
        profiler = {
          binary: klass.createInstance().get(),
          scriptUrl: url.resolve(__url__, "profiler.js")
        };

        profiler.scriptPath = url.toFilename(profiler.scriptUrl);
        profiler.script = require("file").read(profiler.scriptPath);
      }
    } catch (e) {}

    dirs = [url.toFilename(path)
            for each (path in options.rootPaths)];
    var console = new TestRunnerConsole(new ptc.PlainTextConsole(print),
                                        options);

    sandbox = new cuddlefish.Loader({console: console,
                                     __proto__: options});
    nextIteration();
  } catch (e) {
    print(require("traceback").format(e) + "\n" + e + "\n");
    onDone({passed: 0, failed: 1});
  }
};

require("unload").when(
  function() {
    if (consoleListener)
      cService.unregisterListener(consoleListener);
  });
