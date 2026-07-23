// src/index.js — Task scheduler priority queue
//
// Manages a priority queue of tasks. Each task has a priority (1=highest, 10=lowest).
// The scheduler picks the highest-priority task. When priorities are equal, it
// picks the task that was added earliest (FIFO tie-breaking).
// Tasks can be requeued — a requeued task keeps its original insertion order.

"use strict";

function createScheduler() {
  var tasks = [];
  var sequenceCounter = 0;

  function addTask(name, priority) {
    if (typeof priority !== "number" || priority < 1 || priority > 10) {
      throw new Error("priority must be 1-10");
    }
    var task = {
      name: name,
      priority: priority,
      seq: sequenceCounter++,
    };
    tasks.push(task);
    return task;
  }

  function nextTask() {
    if (tasks.length === 0) return null;

    var best = tasks[0];
    for (var i = 1; i < tasks.length; i++) {
      if (tasks[i].priority < best.priority) {
        best = tasks[i];
      }
    }

    var bestIndex = tasks.indexOf(best);
    tasks.splice(bestIndex, 1);
    return best;
  }

  function requeue(task) {
    task.seq = sequenceCounter++;
    tasks.push(task);
  }

  function peek() {
    if (tasks.length === 0) return null;
    var best = tasks[0];
    for (var i = 1; i < tasks.length; i++) {
      if (tasks[i].priority < best.priority) {
        best = tasks[i];
      }
    }
    return best;
  }

  function size() {
    return tasks.length;
  }

  function allTasks() {
    return tasks.slice();
  }

  return {
    addTask: addTask,
    nextTask: nextTask,
    requeue: requeue,
    peek: peek,
    size: size,
    allTasks: allTasks,
  };
}

module.exports = { createScheduler: createScheduler };
