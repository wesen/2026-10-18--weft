package hw

import (
	"io"
	"os"
	"time"

	"github.com/pkg/errors"
	"golang.org/x/sys/unix"
)

// serialPort is the board's UART: raw 8N1, no flow control (the A1-EVB's RP2040 bridge has none).
type serialPort struct{ *os.File }

var bauds = map[int]uint32{9600: unix.B9600, 19200: unix.B19200, 38400: unix.B38400, 57600: unix.B57600,
	115200: unix.B115200, 230400: unix.B230400, 460800: unix.B460800, 921600: unix.B921600}

// openSerial opens dev raw at baud. The file is non-blocking underneath, so Close ends a pending Read.
func openSerial(dev string, baud int) (*serialPort, error) {
	speed, ok := bauds[baud]
	if !ok {
		return nil, errors.Errorf("unsupported baud rate %d", baud)
	}
	fd, err := unix.Open(dev, unix.O_RDWR|unix.O_NOCTTY|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, errors.Wrapf(err, "open %s", dev)
	}
	t, err := unix.IoctlGetTermios(fd, unix.TCGETS)
	if err != nil {
		_ = unix.Close(fd)
		return nil, errors.Wrapf(err, "%s is not a serial port", dev)
	}
	t.Iflag, t.Oflag, t.Lflag = 0, 0, 0
	t.Cflag = unix.CS8 | unix.CREAD | unix.CLOCAL | speed
	t.Ispeed, t.Ospeed = speed, speed
	t.Cc[unix.VMIN], t.Cc[unix.VTIME] = 1, 0
	if err := unix.IoctlSetTermios(fd, unix.TCSETS, t); err != nil {
		_ = unix.Close(fd)
		return nil, errors.Wrapf(err, "configure %s", dev)
	}
	f := os.NewFile(uintptr(fd), dev)
	if f == nil {
		_ = unix.Close(fd)
		return nil, errors.Errorf("open %s", dev)
	}
	return &serialPort{f}, nil
}

// drain discards what arrives within d: output the board produced while nobody read, which the USB bridge
// kept.
func (p *serialPort) drain(d time.Duration) {
	buf := make([]byte, 4096)
	end := time.Now().Add(d)
	for time.Now().Before(end) {
		_ = p.SetReadDeadline(time.Now().Add(50 * time.Millisecond))
		if _, err := p.Read(buf); err != nil && !errors.Is(err, os.ErrDeadlineExceeded) {
			break
		}
	}
	_ = p.SetReadDeadline(time.Time{})
}

// writePaced writes data keeping at most window bytes ahead of the line rate: the RP2040 drops what it
// cannot buffer (about 2 KB) instead of pushing back.
func writePaced(w io.Writer, data []byte, baud, window int) error {
	start := time.Now()
	perByte := time.Duration(float64(time.Second) * 10 / float64(baud))
	for sent := 0; sent < len(data); {
		drained := int(time.Since(start) / perByte)
		room := window - (sent - drained)
		if room <= 0 {
			time.Sleep(perByte * time.Duration(-room+1))
			continue
		}
		n, err := w.Write(data[sent:min(len(data), sent+room)])
		sent += n
		if err != nil {
			return err
		}
	}
	return nil
}
