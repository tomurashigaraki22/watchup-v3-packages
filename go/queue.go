package watchup

// Delivery queue (spec §4, §7, §8). Goroutine-safe: items are normalized and
// serialized at capture time; a single worker goroutine sends one chunk at a
// time; failed chunks wait for their backoff without blocking newer chunks and
// are retried with the same idempotency key.

import (
	"context"
	"fmt"
	"math"
	"math/rand"
	"sync"
	"time"
)

// SendResult is what a transport reports for one chunk.
type SendResult struct {
	OK         bool
	Status     int // 0 for network errors and timeouts
	Code       string
	RetryAfter time.Duration
	Err        error
}

// FlushResult summarises one flush.
type FlushResult struct {
	Accepted       int
	DeliveredItems int
	Retrying       int
	Dropped        int
}

// Diagnostic describes a delivery event. It never contains captured data.
type Diagnostic struct {
	Type    string
	Message string
	Details map[string]any
}

type sender func(ctx context.Context, c *Chunk) SendResult

type queueOptions struct {
	send          sender
	base          func() map[string]any
	maxBytes      int
	maxItems      int
	maxQueueItems int
	maxAttempts   int
	baseBackoff   time.Duration
	maxBackoff    time.Duration
	redactKeys    []string
	onDiagnostic  func(Diagnostic)
	autoFlush     bool
	now           func() time.Time
	random        func() float64
	newBatchID    func() string
}

type deliveryQueue struct {
	opts queueOptions

	mu           sync.Mutex
	pending      map[string][]preparedItem
	pendingBytes int
	retry        []*Chunk
	overflow     map[string]int
	delivered    int

	drainMu sync.Mutex
	wake    chan struct{}
	stop    chan struct{}
	done    chan struct{}
	started bool
}

func newDeliveryQueue(o queueOptions) *deliveryQueue {
	if o.maxBytes == 0 {
		o.maxBytes = MaxChunkBytes
	}
	if o.maxItems <= 0 || o.maxItems > MaxChunkItems {
		o.maxItems = MaxChunkItems
	}
	if o.maxQueueItems <= 0 {
		o.maxQueueItems = MaxQueueItems
	}
	if o.maxAttempts <= 0 {
		o.maxAttempts = MaxAttempts
	}
	if o.baseBackoff == 0 {
		o.baseBackoff = BaseBackoffMS * time.Millisecond
	}
	if o.maxBackoff == 0 {
		o.maxBackoff = MaxBackoffMS * time.Millisecond
	}
	if o.now == nil {
		o.now = time.Now
	}
	if o.random == nil {
		o.random = rand.Float64
	}
	if o.newBatchID == nil {
		o.newBatchID = newUUID
	}
	return &deliveryQueue{
		opts:     o,
		pending:  map[string][]preparedItem{},
		overflow: map[string]int{},
		wake:     make(chan struct{}, 1),
		stop:     make(chan struct{}),
		done:     make(chan struct{}),
	}
}

func (q *deliveryQueue) start(interval time.Duration) {
	q.mu.Lock()
	if q.started {
		q.mu.Unlock()
		return
	}
	q.started = true
	q.mu.Unlock()
	go q.run(interval)
}

func (q *deliveryQueue) run(interval time.Duration) {
	defer close(q.done)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		var retryTimer <-chan time.Time
		q.mu.Lock()
		if len(q.retry) > 0 {
			next := q.retry[0].nextAttemptAt
			for _, c := range q.retry[1:] {
				if c.nextAttemptAt.Before(next) {
					next = c.nextAttemptAt
				}
			}
			retryTimer = time.After(time.Until(next))
		}
		q.mu.Unlock()

		select {
		case <-q.stop:
			return
		case <-ticker.C:
		case <-q.wake:
		case <-retryTimer:
		}
		q.flush(context.Background(), false)
	}
}

func (q *deliveryQueue) signal() {
	select {
	case q.wake <- struct{}{}:
	default:
	}
}

func (q *deliveryQueue) enqueue(kind string, item map[string]any) bool {
	normalized, ok := Normalize(item, q.opts.redactKeys).(map[string]any)
	if !ok {
		return false
	}
	budget := q.opts.maxBytes - envelopeOverhead(q.opts.base())
	fit, err := fitItem(normalized, budget)
	if err != nil {
		return false
	}
	noun := kind[:len(kind)-1]
	if fit.truncated {
		q.diagnose("item_truncated", fmt.Sprintf("A %s was truncated to fit the request size limit.", noun), map[string]any{"kind": kind, "bytes": len(fit.json)})
	}
	if fit.oversized {
		q.diagnose("item_oversized", fmt.Sprintf("A %s is still larger than the chunk limit; it will be sent alone.", noun), map[string]any{"kind": kind, "bytes": len(fit.json)})
	}

	q.mu.Lock()
	q.pending[kind] = append(q.pending[kind], preparedItem{kind: kind, json: fit.json})
	q.pendingBytes += len(fit.json)
	q.enforceBound()
	flushNow := q.opts.autoFlush && (q.pendingCountLocked() >= q.opts.maxItems ||
		q.pendingBytes >= q.opts.maxBytes ||
		len(q.pending["errors"]) >= (q.opts.maxItems+1)/2)
	q.mu.Unlock()
	if flushNow {
		q.signal() // never send on the caller's goroutine
	}
	return true
}

func (q *deliveryQueue) pendingCountLocked() int {
	return len(q.pending["errors"]) + len(q.pending["traces"]) + len(q.pending["events"])
}

func (q *deliveryQueue) counts() (pending, retrying int) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for _, c := range q.retry {
		retrying += c.Items()
	}
	return q.pendingCountLocked(), retrying
}

// flush sends pending items and due retries; force sends retries early.
func (q *deliveryQueue) flush(ctx context.Context, force bool) FlushResult {
	var result FlushResult
	q.drainMu.Lock()
	defer q.drainMu.Unlock()

	q.mu.Lock()
	q.reportOverflow()
	now := q.opts.now()
	var due, keep []*Chunk
	for _, c := range q.retry {
		if force || !c.nextAttemptAt.After(now) {
			due = append(due, c)
		} else {
			keep = append(keep, c)
		}
	}
	q.retry = keep
	fresh := q.cut()
	q.mu.Unlock()

	for _, c := range append(due, fresh...) {
		q.sendOne(ctx, c, &result)
	}
	return result
}

func (q *deliveryQueue) cut() []*Chunk {
	if q.pendingCountLocked() == 0 {
		return nil
	}
	groups := q.pending
	q.pending = map[string][]preparedItem{}
	q.pendingBytes = 0
	sentAt := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	return buildChunks(groups, q.opts.base(), q.opts.maxBytes, q.opts.maxItems, q.opts.newBatchID(), sentAt)
}

func (q *deliveryQueue) sendOne(ctx context.Context, c *Chunk, result *FlushResult) {
	c.Attempts++
	res := q.opts.send(ctx, c)
	if res.OK {
		result.Accepted++
		result.DeliveredItems += c.Items()
		q.mu.Lock()
		q.delivered += c.Items()
		q.mu.Unlock()
		return
	}
	details := map[string]any{"idempotency_key": c.IdempotencyKey, "attempt": c.Attempts, "items": c.Items()}
	if res.Status != 0 {
		details["status"] = res.Status
	}
	if res.Code != "" {
		details["code"] = res.Code
	}
	if res.Err != nil {
		details["error"] = res.Err.Error()
	}

	if res.Status != 0 && !isRetryableStatus(res.Status) {
		result.Dropped++
		suffix := ""
		if res.Code != "" {
			suffix = " " + res.Code
		}
		q.diagnose("chunk_rejected", fmt.Sprintf("The server rejected a batch (HTTP %d%s); it will not be retried.", res.Status, suffix), details)
		return
	}
	if c.Attempts >= q.opts.maxAttempts {
		result.Dropped++
		q.diagnose("chunk_dropped", fmt.Sprintf("A batch failed %d times and was dropped.", c.Attempts), details)
		return
	}

	delay := q.backoff(c.Attempts, res.RetryAfter)
	c.nextAttemptAt = q.opts.now().Add(delay)
	q.mu.Lock()
	q.retry = append(q.retry, c)
	for len(q.retry) > MaxRetryChunks {
		old := q.retry[0]
		q.retry = q.retry[1:]
		result.Dropped++
		q.diagnose("chunk_dropped", "Too many batches waiting for a retry; the oldest was dropped.", map[string]any{"idempotency_key": old.IdempotencyKey, "items": old.Items()})
	}
	q.mu.Unlock()
	result.Retrying++
	details["delay_ms"] = delay.Milliseconds()
	q.diagnose("chunk_retry", fmt.Sprintf("Batch delivery failed; retrying in %d ms.", delay.Milliseconds()), details)
}

func (q *deliveryQueue) backoff(attempt int, retryAfter time.Duration) time.Duration {
	if retryAfter > 0 {
		if retryAfter > MaxRetryAfterMS*time.Millisecond {
			return MaxRetryAfterMS * time.Millisecond
		}
		return retryAfter
	}
	exp := float64(q.opts.baseBackoff) * math.Pow(2, float64(attempt-1))
	if exp > float64(q.opts.maxBackoff) {
		exp = float64(q.opts.maxBackoff)
	}
	return time.Duration(math.Round(exp * (0.5 + q.opts.random()*0.5)))
}

// shutdown stops the worker and delivers until ctx is done. Returns undelivered items.
func (q *deliveryQueue) shutdown(ctx context.Context) int {
	q.mu.Lock()
	started := q.started
	q.started = false
	q.mu.Unlock()
	if started {
		close(q.stop)
		<-q.done
	}
loop:
	for {
		q.flush(ctx, false)
		q.mu.Lock()
		var next time.Time
		for i, c := range q.retry {
			if i == 0 || c.nextAttemptAt.Before(next) {
				next = c.nextAttemptAt
			}
		}
		hasRetry := len(q.retry) > 0
		q.mu.Unlock()
		if !hasRetry {
			break // flush already cut every pending item
		}
		wait := next.Sub(q.opts.now())
		if deadline, ok := ctx.Deadline(); !ok || time.Now().Add(wait).After(deadline) {
			break
		}
		select {
		case <-ctx.Done():
			break loop
		case <-time.After(wait):
		}
	}
	pending, retrying := q.counts()
	if undelivered := pending + retrying; undelivered > 0 {
		q.diagnose("undelivered_on_shutdown", fmt.Sprintf("%d item(s) could not be delivered before shutdown.", undelivered),
			map[string]any{"pending": pending, "retrying": retrying})
		return undelivered
	}
	return 0
}

func (q *deliveryQueue) enforceBound() {
	excess := q.pendingCountLocked() - q.opts.maxQueueItems
	for _, kind := range []string{"events", "traces", "errors"} {
		for excess > 0 && len(q.pending[kind]) > 0 {
			q.pendingBytes -= len(q.pending[kind][0].json)
			q.pending[kind] = q.pending[kind][1:]
			q.overflow[kind]++
			excess--
		}
	}
}

func (q *deliveryQueue) reportOverflow() {
	total := q.overflow["errors"] + q.overflow["traces"] + q.overflow["events"]
	if total == 0 {
		return
	}
	details := map[string]any{"errors": q.overflow["errors"], "traces": q.overflow["traces"], "events": q.overflow["events"]}
	q.overflow = map[string]int{}
	q.diagnose("queue_overflow", fmt.Sprintf("The queue was full; dropped %d oldest item(s).", total), details)
}

func (q *deliveryQueue) diagnose(typ, message string, details map[string]any) {
	if q.opts.onDiagnostic == nil {
		return
	}
	defer func() { _ = recover() }()
	q.opts.onDiagnostic(Diagnostic{Type: typ, Message: message, Details: details})
}
