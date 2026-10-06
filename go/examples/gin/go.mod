module example.com/watchup-gin

go 1.21

require (
	github.com/gin-gonic/gin v1.10.0
	github.com/tomurashigaraki22/watchup-go-sdk v0.0.0
)

replace github.com/tomurashigaraki22/watchup-go-sdk => ../..
