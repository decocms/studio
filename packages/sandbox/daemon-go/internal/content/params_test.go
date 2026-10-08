package content

import "testing"

// Ported from params.test.ts; the messages are zod 4's, captured from the
// published package.
func TestValidateParams(t *testing.T) {
	ok := func(method, params string) {
		t.Helper()
		if err := validateParams(method, mustParse(t, params), true); err != nil {
			t.Errorf("%s %s: %v", method, params, err.Message)
		}
	}
	fail := func(method, params, message string) {
		t.Helper()
		err := validateParams(method, mustParse(t, params), true)
		if err == nil || err.Code != CodeInvalidParams || err.Message != message {
			t.Errorf("%s %s:\n got %+v\nwant %q", method, params, err, message)
		}
	}
	if validateParams("describe", nil, false) != nil {
		t.Error("absent params read as {}")
	}
	ok("describe", `{}`)
	fail("describe", `null`, "params must be an object")
	fail("describe", `[]`, "params must be an object")
	fail("describe", `"x"`, "params must be an object")
	fail("describe", `{"a":1}`, `unknown parameter "a"`)
	fail("describe", `{"a":1,"b":2}`, `unknown parameters "a", "b"`)
	ok("describe", `{"__proto__":5}`)
	fail("blocks.list", `{"ifNoneMatch":5}`, "ifNoneMatch: Invalid input: expected string, received number")
	fail("blocks.list", `{"ifNoneMatch":""}`, "ifNoneMatch: Too small: expected string to have >=1 characters")
	fail("blocks.list", `{"ifNoneMatch":[]}`, "ifNoneMatch: Invalid input: expected string, received array; ifNoneMatch: Too small: expected array to have >=1 items")
	fail("blocks.list", `{"zz":1,"ifNoneMatch":5}`, `ifNoneMatch: Invalid input: expected string, received number; unknown parameter "zz"`)
	fail("schema.get", `{"ifNoneMatch":null}`, "ifNoneMatch: Invalid input: expected string, received null")
	ok("schema.get", `{"ifNoneMatch":"v"}`)
	fail("blocks.apply", `{"set":[]}`, "set: Invalid input: expected record, received array")
	fail("blocks.apply", `{"delete":[1,"a",null]}`, "delete.0: Invalid input: expected string, received number; delete.2: Invalid input: expected string, received null")
	fail("blocks.apply", `{"ifMatch":{"a.b":5,"10":true,"2":null,"c":""}}`,
		"ifMatch.10: Invalid input: expected string, received boolean; ifMatch.a.b: Invalid input: expected string, received number; ifMatch.c: Too small: expected string to have >=1 characters")
	fail("blocks.apply", `{"set":1,"delete":2,"ifMatch":3,"q":1}`,
		`set: Invalid input: expected record, received number; delete: Invalid input: expected array, received number; ifMatch: Invalid input: expected record, received number; unknown parameter "q"`)
	for _, removed := range []string{"ref", "refs", "requestKey", "ifSchemaMatch", "ifUnmodifiedSince"} {
		fail("blocks.apply", `{"set":{},"`+removed+`":"x"}`, `unknown parameter "`+removed+`"`)
	}
	ok("blocks.apply", `{"set":{"a":[]},"delete":["a"],"ifMatch":{"a":null,"__proto__":5}}`)
}
