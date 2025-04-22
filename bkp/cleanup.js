/**
 * Cleans up tasks in the provided task map based on their status and activity.
 * 
 * This function iterates through the `taskMap` and removes tasks that are either
 * completed, failed, or stalled for longer than the configured maximum idle time.
 * For stalled tasks, it attempts to terminate their associated processes using
 * `SIGKILL` or `SIGTERM` signals.
 * 
 * @param {Map<string, Object>} taskMap - A map containing task objects, where each key is a task identifier
 * and the value is an object representing the task. Each task object is expected to have the following properties:
 *   - {string} status - The current status of the task (e.g., 'completed', 'failed', 'running').
 *   - {number} lastActivity - The timestamp of the last activity for the task.
 *   - {number} spawnTimeStamp - The timestamp when the task was spawned.
 *   - {Object} spawnedProcess - The child process associated with the task.
 *   - {function} spawnedProcess.kill - A function to terminate the child process.
 * 
 * @throws {Error} Logs errors if process termination fails for stalled tasks.
 */
function cleanupMap(taskMap) {
    const now = Date.now();
    logger.info(`Cleaning up download processes older than ${config.queue.maxIdle / 1000} seconds`);
    logger.trace(`Map State: ${getStateFromMap(taskMap)}`);
    // Iterate through the taskMap and remove completed or stalled tasks
    for (const [key, task] of taskMap.entries()) {
        // logger.trace(`Task ${key} State: ${JSON.stringify(task)}`);
        const { status, lastActivity, spawnTimeStamp } = task;
        logger.debug(`Checking task ${key}, status=${status}, lastActivity=${lastActivity}, spawnTimeStamp=${spawnTimeStamp}`);
        if (status === 'completed' || status === 'failed') {
            logger.debug(`Cleaning up completed task: ${key}`);
            taskMap.delete(key);
        } else if (status === 'running' && (now - spawnTimeStamp > config.queue.maxIdle)) {
            logger.warn(`Cleaning up stalled task: ${key}`);
            logger.trace(`Task ${key} last activity: ${lastActivity}`);
            logger.trace(`Task ${key} spawn time: ${spawnTimeStamp}`);
            logger.trace(`Task ${key} idle time: ${now - spawnTimeStamp / 1000} seconds`);
            logger.trace(`Task ${key} has a kill handler? ${typeof task.spawnedProcess.kill}`);
            if (task && typeof task.spawnedProcess.kill === 'function') {
                try {
                    logger.warn(`Killing stalled process for task ${key} with SIGKILL`);
                    // Attempt to kill the process
                    const killed = task.spawnedProcess.kill('SIGKILL');
                    if (killed) {
                        logger.info(`Killed stalled process for task ${key}`);
                    } else {
                        logger.warn(`Failed to kill stalled process for task ${key}`);
                        const terminate = task.spawnedProcess.kill('SIGTERM');
                        logger.info(`Sent SIGTERM to stalled process for task ${key}`);
                        if (terminate) {
                            logger.info(`Terminated stalled process for task ${key}`);
                        } else {
                            logger.warn(`Failed to terminate stalled process for task ${key}`);
                        }
                    }
                } catch (err) {
                    logger.error(`Failed to kill process for task ${key}:`, { error: err.message });
                }
            }
            taskMap.delete(key);
        }
    }
}
setInterval(() => cleanupMap(downloadProcesses), config.queue.cleanUpInterval);
/**
 * Converts a Map of tasks into a JSON string representation of their statuses.
 *
 * @param {Map<string, {status: string}>} taskMap - A Map where the key is a task identifier (string)
 * and the value is an object containing a `status` property (string).
 * @returns {string} A JSON string representing an object where each key is a task identifier
 * and the value is the corresponding task's status.
 */
function getStateFromMap(taskMap) {
    const resultMap = new Map();
    for (const [key, task] of taskMap.entries()) {
        logger.debug(`Task ${key} with status: ${task.status}`);
        logger.trace(`Task ${key} with status: ${JSON.stringify(task)}`);
        resultMap.set(key, task.status);
    }
    return JSON.stringify(Object.fromEntries(resultMap));
}