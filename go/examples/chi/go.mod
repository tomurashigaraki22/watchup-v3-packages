module example.com/watchup-chi

go 1.21

require (
	github.com/go-chi/chi/v5 v5.1.0
	github.com/tomurashigaraki22/watchup-go-sdk v0.0.0
)

replace github.com/tomurashigaraki22/watchup-go-sdk => ../..
