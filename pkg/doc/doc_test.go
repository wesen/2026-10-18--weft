package doc

import (
	"io/fs"
	"testing"

	"github.com/go-go-golems/glazed/pkg/help/model"
)

// The help system skips a topic that does not parse and says so only at debug level.
func TestTopicsParse(t *testing.T) {
	names, err := fs.Glob(topics, "topics/*.md")
	if err != nil || len(names) == 0 {
		t.Fatalf("no topics: %v", err)
	}
	slugs := map[string]string{}
	for _, name := range names {
		b, err := fs.ReadFile(topics, name)
		if err != nil {
			t.Fatal(err)
		}
		s, err := model.ParseSectionFromMarkdown(b)
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		if prev, dup := slugs[s.Slug]; dup {
			t.Errorf("%s and %s share the slug %q", prev, name, s.Slug)
		}
		slugs[s.Slug] = name
	}
}
