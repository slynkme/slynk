package transfer

import (
	"os"
	"sync"
)

// memKV is an in-memory key-value store for xxDK's storage layer, so a
// client's identity and state exist only for the life of the page and
// nothing is ever written to the visitor's disk or browser storage.
type memKV struct {
	mu   sync.RWMutex
	data map[string][]byte
}

func newMemKV() *memKV {
	return &memKV{data: map[string][]byte{}}
}

func (kv *memKV) Get(key string) ([]byte, error) {
	kv.mu.RLock()
	defer kv.mu.RUnlock()
	v, ok := kv.data[key]
	if !ok {
		// ekv recognises "does not exist" as a missing key.
		return nil, os.ErrNotExist
	}
	return append([]byte(nil), v...), nil
}

func (kv *memKV) Set(key string, value []byte) error {
	kv.mu.Lock()
	kv.data[key] = append([]byte(nil), value...)
	kv.mu.Unlock()
	return nil
}

func (kv *memKV) Delete(key string) error {
	kv.mu.Lock()
	delete(kv.data, key)
	kv.mu.Unlock()
	return nil
}

func (kv *memKV) Keys() ([]string, error) {
	kv.mu.RLock()
	defer kv.mu.RUnlock()
	keys := make([]string, 0, len(kv.data))
	for k := range kv.data {
		keys = append(keys, k)
	}
	return keys, nil
}
